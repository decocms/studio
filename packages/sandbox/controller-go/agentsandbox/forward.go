package agentsandbox

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/portforward"
	"k8s.io/client-go/transport/spdy"
)

// forwarder holds one port-forward per handle for deployments without a
// preview gateway (kind, a laptop), where Studio is outside the sandbox
// network. The returned 127.0.0.1 address is only right when the controller
// and Studio share a host, which is exactly that case.
type forwarder struct {
	rest      *rest.Config
	core      kubernetes.Interface
	namespace string

	mu      sync.Mutex
	forward map[string]*forward
}

type forward struct {
	port uint16
	pod  string
	stop chan struct{}
}

// url opens (or reuses) the forward to pod. A cached entry is dropped when the
// stream dies; one for another pod is replaced, since a recreated pod keeps
// the claim's handle.
func (f *forwarder) url(ctx context.Context, handle, pod string) (string, error) {
	if f.rest == nil {
		return "", errors.New("no preview URL pattern and no REST config to port-forward with")
	}
	f.mu.Lock()
	if existing, ok := f.forward[handle]; ok && existing.pod == pod {
		f.mu.Unlock()
		return fmt.Sprintf("http://127.0.0.1:%d", existing.port), nil
	}
	f.mu.Unlock()
	f.close(handle)

	req := f.core.CoreV1().RESTClient().Post().Resource("pods").Namespace(f.namespace).Name(pod).SubResource("portforward")
	transport, upgrader, err := spdy.RoundTripperFor(f.rest)
	if err != nil {
		return "", err
	}
	dialer := spdy.NewDialer(upgrader, &http.Client{Transport: transport}, http.MethodPost, req.URL())
	stop, ready := make(chan struct{}), make(chan struct{})
	pf, err := portforward.New(dialer, []string{fmt.Sprintf("0:%d", daemonPort)}, stop, ready, io.Discard, io.Discard)
	if err != nil {
		return "", err
	}
	errc := make(chan error, 1)
	go func() {
		err := pf.ForwardPorts()
		f.forget(handle, stop)
		errc <- err
	}()
	select {
	case <-ready:
	case err := <-errc:
		return "", fmt.Errorf("port-forward to %s failed: %w", pod, err)
	case <-time.After(20 * time.Second):
		close(stop)
		return "", fmt.Errorf("port-forward to %s did not become ready", pod)
	case <-ctx.Done():
		close(stop)
		return "", ctx.Err()
	}
	ports, err := pf.GetPorts()
	if err != nil || len(ports) == 0 {
		close(stop)
		return "", fmt.Errorf("port-forward to %s exposed no local port: %v", pod, err)
	}
	f.mu.Lock()
	f.forward[handle] = &forward{port: ports[0].Local, pod: pod, stop: stop}
	f.mu.Unlock()
	return fmt.Sprintf("http://127.0.0.1:%d", ports[0].Local), nil
}

// forget drops the entry only if it is still the one identified by stop.
func (f *forwarder) forget(handle string, stop chan struct{}) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if cur, ok := f.forward[handle]; ok && cur.stop == stop {
		delete(f.forward, handle)
	}
}

func (f *forwarder) close(handle string) {
	f.mu.Lock()
	cur, ok := f.forward[handle]
	delete(f.forward, handle)
	f.mu.Unlock()
	if ok {
		close(cur.stop)
	}
}

func (f *forwarder) closeAll() {
	f.mu.Lock()
	all := f.forward
	f.forward = map[string]*forward{}
	f.mu.Unlock()
	for _, cur := range all {
		close(cur.stop)
	}
}
