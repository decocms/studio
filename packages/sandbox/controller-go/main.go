// Command sandbox-controller is the only process in the deployment that talks
// to an infrastructure API.
//
// Studio reaches it over HTTP (RemoteSandboxProvider) and holds no kubeconfig,
// no CRD verbs and no pods/portforward of its own. The controller returns
// WHERE a sandbox's daemon is and WHAT token opens it; studio's existing fetch
// code talks to the daemon directly, so no request or response body is relayed
// through here.
package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/decocms/studio/sandbox-controller/agentsandbox"
	"github.com/decocms/studio/sandbox-controller/protocol"
	"github.com/decocms/studio/sandbox-controller/runtime"
	"github.com/decocms/studio/sandbox-controller/store"
)

func env(name string) string { return strings.TrimSpace(os.Getenv(name)) }

func envOr(name, fallback string) string {
	if v := env(name); v != "" {
		return v
	}
	return fallback
}

func envDuration(name string, fallback time.Duration) time.Duration {
	raw := env(name)
	if raw == "" {
		return fallback
	}
	ms, err := strconv.Atoi(raw)
	if err != nil {
		slog.Warn("ignoring unparseable duration", "env", name, "value", raw)
		return fallback
	}
	return time.Duration(ms) * time.Millisecond
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	if err := run(); err != nil {
		slog.Error("sandbox-controller exited", "err", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	dsn := env("DATABASE_URL")
	if dsn == "" {
		return errors.New("DATABASE_URL is required")
	}
	st, err := store.New(ctx, dsn)
	if err != nil {
		return err
	}
	defer st.Close()

	runtimes, err := buildRuntimes(st)
	if err != nil {
		return err
	}
	registry := runtime.NewRegistry(runtimes)
	defer registry.Close()
	if len(registry.All()) == 0 {
		slog.Warn("no runtime configured — every ensure will answer 503")
	}

	tlsConfig, err := serverTLS()
	if err != nil {
		return err
	}
	mTLS := tlsConfig != nil && tlsConfig.ClientAuth == tls.RequireAndVerifyClientCert
	bearer := env("SANDBOX_CONTROLLER_TOKEN")
	// Fail closed: an unauthenticated listener here is a credential oracle.
	if !mTLS && bearer == "" {
		if env("SANDBOX_CONTROLLER_INSECURE") != "1" {
			return errors.New(
				"refusing to serve unauthenticated: set SANDBOX_CONTROLLER_TLS_CLIENT_CA (mTLS) " +
					"or SANDBOX_CONTROLLER_TOKEN, or SANDBOX_CONTROLLER_INSECURE=1 for local dev")
		}
		slog.Warn("serving with NO authentication (SANDBOX_CONTROLLER_INSECURE=1)")
	}

	srv := &server{
		registry:      registry,
		store:         st,
		bearer:        bearer,
		mTLS:          mTLS,
		drainDeadline: envDuration("SANDBOX_CONTROLLER_DRAIN_MS", 60*time.Second),
	}

	httpServer := &http.Server{
		Addr:      envOr("HOST", "0.0.0.0") + ":" + envOr("PORT", "8787"),
		Handler:   srv.routes(),
		TLSConfig: tlsConfig,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()

	names := make([]string, 0, len(registry.All()))
	for _, rt := range registry.All() {
		names = append(names, rt.Name)
	}
	slog.Info("listening", "addr", httpServer.Addr, "tls", tlsConfig != nil, "runtimes", names)

	if tlsConfig != nil {
		err = httpServer.ListenAndServeTLS("", "")
	} else {
		err = httpServer.ListenAndServe()
	}
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// serverTLS wires the studio-to-controller mTLS pair: two long-lived peers
// installed by the same deploy, each configured with its own key and the
// other's trust root, so revocation is deleting one entry. Unconfigured falls
// back to the bearer on a ClusterIP-only listener.
func serverTLS() (*tls.Config, error) {
	certFile, keyFile := env("SANDBOX_CONTROLLER_TLS_CERT"), env("SANDBOX_CONTROLLER_TLS_KEY")
	if certFile == "" && keyFile == "" {
		return nil, nil
	}
	if certFile == "" || keyFile == "" {
		return nil, errors.New("SANDBOX_CONTROLLER_TLS_CERT and SANDBOX_CONTROLLER_TLS_KEY must both be set, or both unset")
	}
	pair, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, err
	}
	cfg := &tls.Config{Certificates: []tls.Certificate{pair}, MinVersion: tls.VersionTLS12}
	if caFile := env("SANDBOX_CONTROLLER_TLS_CLIENT_CA"); caFile != "" {
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return nil, err
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("no certificates found in %s", caFile)
		}
		cfg.ClientCAs = pool
		cfg.ClientAuth = tls.RequireAndVerifyClientCert
	}
	return cfg, nil
}

// buildRuntimes registers every runtime this build knows about. The SET of
// runtime types is compiled in — adding one is new code either way — but which
// of them are usable is probed, not configured.
func buildRuntimes(st *store.Store) ([]*runtime.Runtime, error) {
	var out []*runtime.Runtime

	restConfig, err := kubeConfig()
	if err != nil {
		slog.Warn("agent-sandbox runtime unavailable", "err", err)
		return out, nil
	}
	var gateway *agentsandbox.Gateway
	gwName, gwNamespace := env("STUDIO_SANDBOX_PREVIEW_GATEWAY_NAME"), env("STUDIO_SANDBOX_PREVIEW_GATEWAY_NAMESPACE")
	if gwName != "" || gwNamespace != "" {
		if gwName == "" || gwNamespace == "" {
			// Half-configured would silently write routes that never attach,
			// and the failure mode is a 404 from the gateway with no log here.
			return nil, errors.New(
				"STUDIO_SANDBOX_PREVIEW_GATEWAY_NAME and STUDIO_SANDBOX_PREVIEW_GATEWAY_NAMESPACE must both be set, or both unset")
		}
		gateway = &agentsandbox.Gateway{Name: gwName, Namespace: gwNamespace}
	}

	runner, err := agentsandbox.New(restConfig, st, agentsandbox.Config{
		Namespace:         envOr("STUDIO_SANDBOX_NAMESPACE", "agent-sandbox-system"),
		PreviewURLPattern: env("STUDIO_SANDBOX_PREVIEW_URL_PATTERN"),
		TemplateName:      env("STUDIO_SANDBOX_TEMPLATE_NAME"),
		EnvName:           env("STUDIO_ENV"),
		SentinelToken:     env("STUDIO_SANDBOX_SENTINEL_TOKEN"),
		PreviewGateway:    gateway,
		IdleTTL:           envDuration("STUDIO_SANDBOX_IDLE_TTL_MS", 15*time.Minute),
		MintCloneURL:      cloneMinter(),
	})
	if err != nil {
		slog.Warn("agent-sandbox runtime unavailable", "err", err)
		return out, nil
	}

	out = append(out, &runtime.Runtime{
		Name:     agentsandbox.Name,
		Priority: 10,
		Capabilities: []protocol.Capability{
			protocol.CapPreview,
			protocol.CapLifecyclePhases,
			protocol.CapWarmPool,
			protocol.CapTerminationReason,
			protocol.CapTTLExtend,
			protocol.CapCapacity,
		},
		Provider: runner,
		Probe:    runner.Probe,
	})
	return out, nil
}

func kubeConfig() (*rest.Config, error) {
	if cfg, err := rest.InClusterConfig(); err == nil {
		return cfg, nil
	}
	return clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		clientcmd.NewDefaultClientConfigLoadingRules(), &clientcmd.ConfigOverrides{},
	).ClientConfig()
}

// cloneMinter calls studio back for a fresh clone credential. Minting needs
// studio's database and vault, so it cannot move here — and the controller
// never chooses WHICH connection is minted: it echoes the one already recorded
// on the sandbox, and studio verifies that before handing back a token.
func cloneMinter() func(context.Context, string, string, int64) (string, error) {
	base := strings.TrimRight(env("STUDIO_CALLBACK_URL"), "/")
	token := env("STUDIO_CALLBACK_TOKEN")
	if base == "" {
		return nil
	}
	client := &http.Client{Timeout: 20 * time.Second}
	return func(ctx context.Context, connectionID, cloneURL string, bufferMs int64) (string, error) {
		blob, err := json.Marshal(protocol.CloneURLRequest{
			ConnectionID: connectionID, CloneURL: cloneURL, BufferMs: bufferMs,
		})
		if err != nil {
			return "", err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+protocol.CloneURLPath, bytes.NewReader(blob))
		if err != nil {
			return "", err
		}
		req.Header.Set("content-type", "application/json")
		if token != "" {
			req.Header.Set("authorization", "Bearer "+token)
		}
		res, err := client.Do(req)
		if err != nil {
			return "", err
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			detail, _ := io.ReadAll(io.LimitReader(res.Body, 512))
			return "", fmt.Errorf("clone-url callback returned %d: %s", res.StatusCode, detail)
		}
		var out protocol.CloneURLResponse
		if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
			return "", err
		}
		return out.CloneURL, nil
	}
}
