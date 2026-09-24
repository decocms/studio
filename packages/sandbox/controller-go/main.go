// Command sandbox-controller reconciles SandboxVariants into the
// SandboxTemplates and SandboxWarmPools a variant claim resolves to, and, with
// --claims-listen, serves the claim API Studio's RemoteSandboxProvider speaks.
//
//go:generate go run sigs.k8s.io/controller-tools/cmd/controller-gen@v0.20.0 object paths=./api/... crd:crdVersions=v1 output:crd:dir=../../../deploy/helm/sandbox-controller/crds
//go:generate go run ./cmd/tsgen ../../../deploy/helm/sandbox-controller/crds/sandbox.deco.cx_sandboxvariants.yaml ../controller-types/sandbox-variant.ts
//go:generate go run ./cmd/tsgen api ./protocol ../controller-types/sandbox-api.ts
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
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
}

func main() {
	var namespace, metricsAddr, probeAddr string
	var leaderElect bool
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
	opts := zap.Options{}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()
	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))
	log := ctrl.Log.WithName("sandbox-controller")
	fail := func(err error, msg string) {
		log.Error(err, msg)
		os.Exit(1)
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

// setupClaims wires the claim API onto the manager: the HTTP server on every
// replica (it is stateless over the database), the credential refresher on the
// leader only.
func setupClaims(mgr manager.Manager, namespace string, cf claimFlags) (func(), error) {
	tlsConfig, err := server.TLS(cf.tlsCert, cf.tlsKey, cf.clientCA)
	if err != nil {
		return nil, err
	}
	dsn := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if dsn == "" {
		return nil, errors.New("DATABASE_URL is required with --claims-listen")
	}
	if (cf.gatewayName == "") != (cf.gatewayNamespace == "") {
		// Half-configured writes routes that never attach, and the failure is a
		// gateway 404 with no log here.
		return nil, errors.New("--preview-gateway-name and --preview-gateway-namespace must both be set, or both unset")
	}
	pools, err := agentsandbox.ParseTenantPools(os.Getenv("STUDIO_SANDBOX_TENANT_POOLS"))
	if err != nil {
		return nil, err
	}
	var callbacks agentsandbox.Studio
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
	restConfig := mgr.GetConfig()
	dyn, err := dynamic.NewForConfig(restConfig)
	if err != nil {
		return nil, err
	}
	core, err := kubernetes.NewForConfig(restConfig)
	if err != nil {
		return nil, err
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
		Studio:            callbacks,
		Variants: func(ctx context.Context) ([]v1alpha1.SandboxVariant, error) {
			var list v1alpha1.SandboxVariantList
			err := cached.List(ctx, &list, client.InNamespace(namespace))
			return list.Items, err
		},
	})
	if err != nil {
		st.Close()
		return nil, err
	}
	registry := runtime.NewRegistry(&runtime.Runtime{
		Name: agentsandbox.Name, Priority: 10, Capabilities: agentsandbox.Capabilities, Provider: runner,
	})
	srv := &http.Server{
		Addr:              cf.listen,
		Handler:           (&server.Server{Registry: registry, Store: st, DeleteDeadline: cf.deleteDeadline}).Handler(),
		TLSConfig:         tlsConfig,
		ReadHeaderTimeout: 10 * time.Second,
	}
	if err := mgr.Add(claimAPI{srv}); err != nil {
		st.Close()
		return nil, err
	}
	if err := mgr.Add(manager.RunnableFunc(runner.RunCredentialRefresher)); err != nil {
		st.Close()
		return nil, err
	}
	return func() {
		registry.Close()
		st.Close()
	}, nil
}

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
