package variant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/remote/transport"
)

// ImageExists reports whether ref resolves in its registry. (false, nil) only
// for a definite "no such tag"; any other failure is an error, so a registry
// outage never looks like a missing image.
type ImageExists func(ctx context.Context, ref string, kc authn.Keychain) (bool, error)

// RegistryHead is ImageExists over a registry HEAD.
func RegistryHead(ctx context.Context, ref string, kc authn.Keychain) (bool, error) {
	r, err := name.ParseReference(ref, name.StrictValidation)
	if err != nil {
		return false, err
	}
	_, err = remote.Head(r, remote.WithContext(ctx), remote.WithAuthFromKeychain(kc))
	var terr *transport.Error
	if errors.As(err, &terr) && terr.StatusCode == http.StatusNotFound {
		return false, nil
	}
	return err == nil, err
}

// pullSecretKeychain resolves registries from the base template's
// imagePullSecrets (`.dockerconfigjson`), anonymous for the rest — the same
// credentials the kubelet will use to pull the variant.
type pullSecretKeychain map[string]authn.AuthConfig

func keychainFromDockerConfigs(configs [][]byte) (pullSecretKeychain, error) {
	kc := pullSecretKeychain{}
	for _, raw := range configs {
		var cfg struct {
			Auths map[string]authn.AuthConfig `json:"auths"`
		}
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return nil, fmt.Errorf("imagePullSecret: %w", err)
		}
		for host, auth := range cfg.Auths {
			host = strings.TrimPrefix(strings.TrimPrefix(host, "https://"), "http://")
			kc[strings.TrimSuffix(host, "/")] = auth
		}
	}
	return kc, nil
}

func (kc pullSecretKeychain) Resolve(res authn.Resource) (authn.Authenticator, error) {
	if auth, ok := kc[res.RegistryStr()]; ok {
		return authn.FromConfig(auth), nil
	}
	return authn.Anonymous, nil
}
