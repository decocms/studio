package config

// DeepMerge applies a partial patch over the current config: absent fields
// keep current, present fields set, nested objects merge field-by-field,
// env is per-key with null deletes.
func DeepMerge(current *TenantConfig, patch *Patch) *TenantConfig {
	base := current
	if base == nil {
		base = &TenantConfig{}
	}
	cloneOnly := base.CloneOnly
	if patch.CloneOnly != nil {
		cloneOnly = patch.CloneOnly
	}
	out := &TenantConfig{
		Git:         mergeGit(base.Git, patch.Git),
		Operator:    mergeOperator(base.Operator, patch.Operator),
		CloneOnly:   cloneOnly,
		Application: mergeApplication(base.Application, patch.Application),
		Env:         mergeEnv(base.Env, patch),
	}
	return out
}

func mergeEnv(current map[string]string, patch *Patch) map[string]string {
	if !patch.HasEnv {
		if current == nil {
			return nil
		}
		out := make(map[string]string, len(current))
		for k, v := range current {
			out[k] = v
		}
		return out
	}
	out := map[string]string{}
	for k, v := range current {
		out[k] = v
	}
	for k, v := range patch.Env {
		if v == nil {
			delete(out, k)
		} else {
			out[k] = *v
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func mergeGit(current, patch *GitConfig) *GitConfig {
	if patch == nil {
		return current
	}
	if current == nil {
		return patch
	}
	return &GitConfig{
		Repository: mergeRepository(current.Repository, patch.Repository),
		Identity:   mergeIdentity(current.Identity, patch.Identity),
	}
}

func mergeRepository(current, patch *GitRepository) *GitRepository {
	if patch == nil {
		return current
	}
	if current == nil {
		return patch
	}
	out := *current
	if patch.CloneUrl != nil {
		out.CloneUrl = patch.CloneUrl
	}
	if patch.Branch != nil {
		out.Branch = patch.Branch
	}
	if patch.RepoName != nil {
		out.RepoName = patch.RepoName
	}
	return &out
}

func mergeIdentity(current, patch *GitIdentity) *GitIdentity {
	if patch == nil {
		return current
	}
	if current == nil {
		return patch
	}
	out := *current
	if patch.UserName != nil {
		out.UserName = patch.UserName
	}
	if patch.UserEmail != nil {
		out.UserEmail = patch.UserEmail
	}
	return &out
}

func mergeOperator(current, patch *Operator) *Operator {
	if patch == nil {
		return current
	}
	if current == nil {
		return patch
	}
	out := *current
	if patch.UserName != nil {
		out.UserName = patch.UserName
	}
	if patch.UserEmail != nil {
		out.UserEmail = patch.UserEmail
	}
	return &out
}

func mergeApplication(current, patch *Application) *Application {
	if patch == nil {
		return current
	}
	if current == nil {
		return patch
	}
	out := *current
	if patch.PackageManager != nil {
		out.PackageManager = mergePm(current.PackageManager, patch.PackageManager)
	}
	if patch.Runtime != nil {
		out.Runtime = patch.Runtime
	}
	if patch.Port != nil {
		out.Port = patch.Port
	}
	return &out
}

func mergePm(current, patch *PackageManagerConfig) *PackageManagerConfig {
	if current == nil {
		return patch
	}
	out := *current
	if patch.Name != nil {
		out.Name = patch.Name
	}
	if patch.Path != nil {
		out.Path = patch.Path
	}
	return &out
}
