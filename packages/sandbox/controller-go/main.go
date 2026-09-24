// Command sandbox-controller reconciles SandboxVariants into the
// SandboxTemplates and SandboxWarmPools a variant claim resolves to.
//
//go:generate go run sigs.k8s.io/controller-tools/cmd/controller-gen@v0.20.0 object paths=./api/... crd:crdVersions=v1 output:crd:dir=../../../deploy/helm/sandbox-controller/crds
//go:generate go run ./cmd/tsgen ../../../deploy/helm/sandbox-controller/crds/sandbox.deco.cx_sandboxvariants.yaml ../controller-types/sandbox-variant.ts
package main

import (
	"flag"
	"os"

	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	"github.com/decocms/studio/packages/sandbox/controller-go/api/v1alpha1"
	"github.com/decocms/studio/packages/sandbox/controller-go/variant"
)

func main() {
	var namespace, metricsAddr, probeAddr string
	var leaderElect bool
	flag.StringVar(&namespace, "namespace", "agent-sandbox-system", "namespace holding the SandboxTemplates and SandboxVariants")
	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8080", "metrics endpoint")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "healthz/readyz endpoint")
	flag.BoolVar(&leaderElect, "leader-elect", true, "one active replica at a time")
	opts := zap.Options{}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()
	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))
	log := ctrl.Log.WithName("sandbox-controller")

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		log.Error(err, "scheme")
		os.Exit(1)
	}
	if err := v1alpha1.AddToScheme(scheme); err != nil {
		log.Error(err, "scheme")
		os.Exit(1)
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
		log.Error(err, "manager")
		os.Exit(1)
	}
	r := &variant.Reconciler{Client: mgr.GetClient(), APIReader: mgr.GetAPIReader(), ImageExists: variant.RegistryHead}
	if err := r.SetupWithManager(mgr); err != nil {
		log.Error(err, "controller")
		os.Exit(1)
	}
	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		log.Error(err, "healthz")
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		log.Error(err, "readyz")
		os.Exit(1)
	}
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		log.Error(err, "exited")
		os.Exit(1)
	}
}
