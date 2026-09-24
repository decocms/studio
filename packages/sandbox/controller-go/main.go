// Command sandbox-controller reconciles SandboxVariants into the
// SandboxTemplates and SandboxWarmPools a variant claim resolves to, and, with
// --claims-listen, serves the claim API Studio's RemoteSandboxProvider speaks.
// With --kubernetes=false it serves only the claim API, on the docker runtime.
//
//go:generate go run sigs.k8s.io/controller-tools/cmd/controller-gen@v0.20.0 object paths=./api/... crd:crdVersions=v1 output:crd:dir=../../../deploy/helm/sandbox-controller/crds
//go:generate go run ./cmd/tsgen ../../../deploy/helm/sandbox-controller/crds/sandbox.deco.cx_sandboxvariants.yaml ../controller-types/sandbox-variant.ts
//go:generate go run ./cmd/tsgen api ./protocol ../controller-types/sandbox-api.ts
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/manager"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	"github.com/decocms/studio/packages/sandbox/controller-go/agentsandbox"
	"github.com/decocms/studio/packages/sandbox/controller-go/api/v1alpha1"
	"github.com/decocms/studio/packages/sandbox/controller-go/daemonclient"
	"github.com/decocms/studio/packages/sandbox/controller-go/docker"
	"github.com/decocms/studio/packages/sandbox/controller-go/runtime"
	"github.com/decocms/studio/packages/sandbox/controller-go/server"
	"github.com/decocms/studio/packages/sandbox/controller-go/store"
	"github.com/decocms/studio/packages/sandbox/controller-go/studio"
	"github.com/decocms/studio/packages/sandbox/controller-go/variant"
)

type claimFlags struct {
	listen                        string
	tlsCert, tlsKey, clientCA     string
	studioURL, studioCA           string
	template, envName             string
	previewPattern                string
	gatewayName, gatewayNamespace string
	idleTTL, deleteDeadline       time.Duration
	docker                        dockerFlags
}

type dockerFlags struct {
	enabled         bool
	image, variants string
	memory, cpus    string
	stopGrace       time.Duration
}

func main() {
	var namespace, metricsAddr, probeAddr string
	var leaderElect, kubernetes bool
	var cf claimFlags
	flag.StringVar(&namespace, "namespace", "agent-sandbox-system", "namespace holding the SandboxTemplates, SandboxVariants and SandboxClaims")
	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "metrics endpoint")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "healthz/readyz endpoint")
	flag.BoolVar(&leaderElect, "leader-elect", true, "one active replica at a time")
	flag.StringVar(&cf.listen, "claims-listen", "", "address for the claim API (e.g. :8443); empty keeps it off and the controller only reconciles variants")
	flag.StringVar(&cf.tlsCert, "claims-tls-cert", "", "claim API server certificate, also presented on callbacks to Studio")
	flag.StringVar(&cf.tlsKey, "claims-tls-key", "", "key for --claims-tls-cert")
	flag.StringVar(&cf.clientCA, "claims-client-ca", "", "CA that signs Studio's client certificate; required")
	flag.StringVar(&cf.studioURL, "studio-callback-url", "", "https base URL of Studio for credential callbacks; empty disables re-minting")
	flag.StringVar(&cf.studioCA, "studio-ca", "", "CA to verify Studio's server certificate on callbacks; system roots when empty")
	flag.StringVar(&cf.template, "sandbox-template", "studio-sandbox", "base SandboxTemplate claims reference")
	flag.StringVar(&cf.envName, "env-name", "", "stamped as studio.decocms.com/env on claims, pods and routes")
	flag.StringVar(&cf.previewPattern, "preview-url-pattern", "", "preview URL pattern (e.g. https://{handle}.preview.example.com); set means Studio reaches daemons by Service DNS")
	flag.StringVar(&cf.gatewayName, "preview-gateway-name", "", "Gateway per-claim HTTPRoutes attach to")
	flag.StringVar(&cf.gatewayNamespace, "preview-gateway-namespace", "", "namespace of --preview-gateway-name")
	flag.DurationVar(&cf.idleTTL, "idle-ttl", 15*time.Minute, "claim shutdown window each ensure and renewal pushes out")
	flag.DurationVar(&cf.deleteDeadline, "delete-deadline", 30*time.Second, "how long DELETE waits for the claim to go before answering 202")
	flag.BoolVar(&kubernetes, "kubernetes", true, "run the Kubernetes side: the SandboxVariant reconciler and the agent-sandbox runtime; false serves the claim API on the docker runtime alone, with no cluster")
	flag.BoolVar(&cf.docker.enabled, "docker", false, "add the docker runtime to the claim API: one container per sandbox on the engine the docker CLI reaches (DOCKER_HOST)")
	flag.StringVar(&cf.docker.image, "docker-image", os.Getenv("SANDBOX_DOCKER_IMAGE"), "sandbox image the docker runtime serves as default (env SANDBOX_DOCKER_IMAGE)")
	flag.StringVar(&cf.docker.variants, "docker-variants", os.Getenv("SANDBOX_DOCKER_VARIANTS"), "named sandbox images for the docker runtime, name=image,... (env SANDBOX_DOCKER_VARIANTS)")
	flag.StringVar(&cf.docker.memory, "docker-memory", "4g", "docker --memory per sandbox container, the pod's limit by default")
	flag.StringVar(&cf.docker.cpus, "docker-cpus", "2", "docker --cpus per sandbox container, the pod's limit by default")
	flag.DurationVar(&cf.docker.stopGrace, "docker-stop-grace", 90*time.Second, "docker stop --time: the daemon publishes the working tree on SIGTERM")
	opts := zap.Options{}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()
	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))
	log := ctrl.Log.WithName("sandbox-controller")
	fail := func(err error, msg string) {
		log.Error(err, msg)
		os.Exit(1)
	}
	if !kubernetes {
		if cf.listen == "" || !cf.docker.enabled {
			fail(errors.New("--kubernetes=false serves the claim API on the docker runtime: set --claims-listen and --docker"), "flags")
		}
		if err := runLocal(ctrl.SetupSignalHandler(), cf); err != nil {
			fail(err, "claim API")
		}
		return
	}

	scheme := k8sruntime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		fail(err, "scheme")
	}
	if err := v1alpha1.AddToScheme(scheme); err != nil {
		fail(err, "scheme")
	}

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:                  scheme,
		Cache:                   cache.Options{DefaultNamespaces: map[string]cache.Config{namespace: {}}},
		Metrics:                 metricsserver.Options{BindAddress: metricsAddr},
		HealthProbeBindAddress:  probeAddr,
		LeaderElection:          leaderElect,
		LeaderElectionID:        "sandbox-controller.sandbox.deco.cx",
		LeaderElectionNamespace: namespace,
		// main exits as soon as the manager stops, so handing the lease over on
		// SIGTERM is safe, and a rollout's new pod does not wait out the lease.
		LeaderElectionReleaseOnCancel: true,
	})
	if err != nil {
		fail(err, "manager")
	}
	r := &variant.Reconciler{Client: mgr.GetClient(), APIReader: mgr.GetAPIReader(), ImageExists: variant.RegistryHead}
	if err := r.SetupWithManager(mgr); err != nil {
		fail(err, "controller")
	}
	if cf.listen != "" {
		closeClaims, err := setupClaims(mgr, namespace, cf)
		if err != nil {
			fail(err, "claim API")
		}
		defer closeClaims()
	}
	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		fail(err, "healthz")
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		fail(err, "readyz")
	}
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		log.Error(err, "exited")
		os.Exit(1)
	}
}

// claimDeps is what every runtime and the claim API share.
type claimDeps struct {
	tls    *tls.Config
	store  *store.Postgres
	studio daemonclient.Studio
}

func newClaimDeps(cf claimFlags) (*claimDeps, error) {
	tlsConfig, err := server.TLS(cf.tlsCert, cf.tlsKey, cf.clientCA)
	if err != nil {
		return nil, err
	}
	dsn := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if dsn == "" {
		return nil, errors.New("DATABASE_URL is required with --claims-listen")
	}
	var callbacks daemonclient.Studio
	if cf.studioURL != "" {
		clientTLS, err := studio.ClientTLS(cf.tlsCert, cf.tlsKey, cf.studioCA)
		if err != nil {
			return nil, err
		}
		c, err := studio.New(cf.studioURL, clientTLS)
		if err != nil {
			return nil, err
		}
		callbacks = c
	}
	st, err := store.NewPostgres(context.Background(), dsn)
	if err != nil {
		return nil, err
	}
	return &claimDeps{tls: tlsConfig, store: st, studio: callbacks}, nil
}

func (d *claimDeps) server(cf claimFlags, registry *runtime.Registry) *http.Server {
	return &http.Server{
		Addr:              cf.listen,
		Handler:           (&server.Server{Registry: registry, Store: d.store, DeleteDeadline: cf.deleteDeadline}).Handler(),
		TLSConfig:         d.tls,
		ReadHeaderTimeout: 10 * time.Second,
	}
}

// dockerRuntime ranks after agent-sandbox: with both, an unpinned sandbox
// goes to the cluster.
func dockerRuntime(cf claimFlags, d *claimDeps) (*runtime.Runtime, *docker.Runner, error) {
	images, err := parseDockerImages(cf.docker.image, cf.docker.variants)
	if err != nil {
		return nil, nil, err
	}
	runner, err := docker.New(docker.Deps{Store: d.store}, docker.Config{
		Images:    images,
		IdleTTL:   cf.idleTTL,
		StopGrace: cf.docker.stopGrace,
		Memory:    cf.docker.memory,
		CPUs:      cf.docker.cpus,
		Studio:    d.studio,
	})
	if err != nil {
		return nil, nil, err
	}
	return &runtime.Runtime{Name: docker.Name, Priority: 20, Capabilities: docker.Capabilities, Provider: runner}, runner, nil
}

// parseDockerImages builds the docker runtime's name → image map from the
// default image and `name=image,...`.
func parseDockerImages(defaultImage, variants string) (map[string]string, error) {
	if strings.TrimSpace(defaultImage) == "" {
		return nil, errors.New("--docker needs --docker-image (or SANDBOX_DOCKER_IMAGE)")
	}
	images := map[string]string{"default": strings.TrimSpace(defaultImage)}
	for _, entry := range strings.Split(variants, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		name, image, ok := strings.Cut(entry, "=")
		name, image = strings.TrimSpace(name), strings.TrimSpace(image)
		if !ok || !imageName.MatchString(name) || name == "default" || image == "" {
			return nil, fmt.Errorf("--docker-variants: %q is not name=image with a sandbox image name", entry)
		}
		if _, dup := images[name]; dup {
			return nil, fmt.Errorf("--docker-variants: %q is listed twice", name)
		}
		images[name] = image
	}
	return images, nil
}

// imageName is the rule repositories.sandbox_image values follow.
var imageName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

// keepArmed re-arms idle timers for containers a previous process left,
// retrying while the engine is down: an unarmed container runs forever.
func keepArmed(ctx context.Context, runner *docker.Runner) error {
	for {
		err := runner.RearmIdle(ctx)
		if err == nil {
			return nil
		}
		ctrl.Log.WithName("docker").Info("re-arming idle timers failed; retrying", "err", err.Error())
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(30 * time.Second):
		}
	}
}

// runLocal serves the claim API on the docker runtime alone, with no cluster.
func runLocal(ctx context.Context, cf claimFlags) error {
	d, err := newClaimDeps(cf)
	if err != nil {
		return err
	}
	defer d.store.Close()
	rt, runner, err := dockerRuntime(cf, d)
	if err != nil {
		return err
	}
	registry := runtime.NewRegistry(rt)
	defer registry.Close()
	go func() { _ = keepArmed(ctx, runner) }()
	return claimAPI{d.server(cf, registry)}.Start(ctx)
}

// setupClaims wires the claim API onto the manager: the HTTP server on every
// replica (it is stateless over the database), the credential refresher on the
// leader only.
func setupClaims(mgr manager.Manager, namespace string, cf claimFlags) (func(), error) {
	if (cf.gatewayName == "") != (cf.gatewayNamespace == "") {
		// Half-configured writes routes that never attach, and the failure is a
		// gateway 404 with no log here.
		return nil, errors.New("--preview-gateway-name and --preview-gateway-namespace must both be set, or both unset")
	}
	pools, err := agentsandbox.ParseTenantPools(os.Getenv("STUDIO_SANDBOX_TENANT_POOLS"))
	if err != nil {
		return nil, err
	}
	d, err := newClaimDeps(cf)
	if err != nil {
		return nil, err
	}
	st := d.store
	fail := func(err error) (func(), error) {
		st.Close()
		return nil, err
	}
	restConfig := mgr.GetConfig()
	dyn, err := dynamic.NewForConfig(restConfig)
	if err != nil {
		return fail(err)
	}
	core, err := kubernetes.NewForConfig(restConfig)
	if err != nil {
		return fail(err)
	}
	var gateway *agentsandbox.Gateway
	if cf.gatewayName != "" {
		gateway = &agentsandbox.Gateway{Name: cf.gatewayName, Namespace: cf.gatewayNamespace}
	}
	cached := mgr.GetClient()
	runner, err := agentsandbox.New(agentsandbox.Deps{Dynamic: dyn, Core: core, Rest: restConfig, Store: st}, agentsandbox.Config{
		Namespace:         namespace,
		TemplateName:      cf.template,
		EnvName:           cf.envName,
		PreviewURLPattern: cf.previewPattern,
		PreviewGateway:    gateway,
		SentinelToken:     os.Getenv("STUDIO_SANDBOX_SENTINEL_TOKEN"),
		IdleTTL:           cf.idleTTL,
		TenantPools:       pools,
		Studio:            d.studio,
		Variants: func(ctx context.Context) ([]v1alpha1.SandboxVariant, error) {
			var list v1alpha1.SandboxVariantList
			err := cached.List(ctx, &list, client.InNamespace(namespace))
			return list.Items, err
		},
	})
	if err != nil {
		return fail(err)
	}
	runtimes := []*runtime.Runtime{{
		Name: agentsandbox.Name, Priority: 10, Capabilities: agentsandbox.Capabilities, Provider: runner,
	}}
	if cf.docker.enabled {
		rt, dockerRunner, err := dockerRuntime(cf, d)
		if err != nil {
			return fail(err)
		}
		runtimes = append(runtimes, rt)
		if err := mgr.Add(everyReplica(func(ctx context.Context) error { return keepArmed(ctx, dockerRunner) })); err != nil {
			return fail(err)
		}
	}
	registry := runtime.NewRegistry(runtimes...)
	if err := mgr.Add(claimAPI{d.server(cf, registry)}); err != nil {
		return fail(err)
	}
	if err := mgr.Add(manager.RunnableFunc(runner.RunCredentialRefresher)); err != nil {
		return fail(err)
	}
	return func() {
		registry.Close()
		st.Close()
	}, nil
}

// everyReplica runs fn on every replica, leader or not.
type everyReplica func(ctx context.Context) error

func (everyReplica) NeedLeaderElection() bool { return false }

func (f everyReplica) Start(ctx context.Context) error { return f(ctx) }

// claimAPI serves on every replica, leader or not.
type claimAPI struct{ srv *http.Server }

func (claimAPI) NeedLeaderElection() bool { return false }

func (c claimAPI) Start(ctx context.Context) error {
	errc := make(chan error, 1)
	go func() { errc <- c.srv.ListenAndServeTLS("", "") }()
	select {
	case err := <-errc:
		return fmt.Errorf("claim API: %w", err)
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = c.srv.Shutdown(shutdown)
		return nil
	}
}
