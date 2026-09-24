// Package studio is the controller's client for its callbacks into Studio,
// over the same mTLS pair Studio uses to call the controller.
package studio

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
)

type Client struct {
	base string
	http *http.Client
}

// ClientTLS presents the controller's certificate and verifies Studio against
// caFile, or the system roots when it is empty.
func ClientTLS(certFile, keyFile, caFile string) (*tls.Config, error) {
	pair, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("controller certificate: %w", err)
	}
	cfg := &tls.Config{Certificates: []tls.Certificate{pair}, MinVersion: tls.VersionTLS12}
	if caFile != "" {
		pool, err := LoadCAs(caFile)
		if err != nil {
			return nil, err
		}
		cfg.RootCAs = pool
	}
	return cfg, nil
}

func LoadCAs(file string) (*x509.CertPool, error) {
	pem, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("no certificates found in %s", file)
	}
	return pool, nil
}

func New(baseURL string, tlsConfig *tls.Config) (*Client, error) {
	base := strings.TrimRight(baseURL, "/")
	if !strings.HasPrefix(base, "https://") {
		return nil, errors.New("the Studio callback URL must be https: the callback is authenticated by mTLS")
	}
	return &Client{base: base, http: &http.Client{
		Timeout:   20 * time.Second,
		Transport: &http.Transport{TLSClientConfig: tlsConfig},
	}}, nil
}

func (c *Client) post(ctx context.Context, path string, body, out any) error {
	blob, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(blob))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	if res.StatusCode != http.StatusOK {
		if len(payload) > 512 {
			payload = payload[:512]
		}
		return fmt.Errorf("%s returned %d: %s", path, res.StatusCode, payload)
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return fmt.Errorf("%s returned a malformed body: %w", path, err)
	}
	return nil
}

// MintCloneURL asks Studio for a fresh credential for the repository the
// sandbox already has. "" when Studio declines.
func (c *Client) MintCloneURL(ctx context.Context, repo protocol.EnsureRepo, bufferMs int64) (string, error) {
	var out protocol.CloneURLResponse
	err := c.post(ctx, protocol.CloneURLPath, protocol.CloneURLRequest{
		ConnectionID: repo.ConnectionID, RepositoryID: repo.RepositoryID, CloneURL: repo.CloneURL, BufferMs: bufferMs,
	}, &out)
	if err != nil || out.CloneURL == nil {
		return "", err
	}
	return *out.CloneURL, nil
}

// MintOrgFsConfig asks Studio for a fresh org-fs mount config. "" when Studio
// declines.
func (c *Client) MintOrgFsConfig(ctx context.Context, tenant protocol.Tenant) (string, error) {
	var out protocol.OrgFsConfigResponse
	err := c.post(ctx, protocol.OrgFsConfigPath, protocol.OrgFsConfigRequest{Tenant: tenant}, &out)
	if err != nil || out.OrgFsConfigJSON == nil {
		return "", err
	}
	return *out.OrgFsConfigJSON, nil
}
