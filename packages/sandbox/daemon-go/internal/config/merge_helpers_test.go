package config

import (
	"testing"
)

func TestMergeOperator(t *testing.T) {
	t.Run("patch nil keeps current", func(t *testing.T) {
		current := &Operator{UserName: Str("alice"), UserEmail: Str("alice@example.com")}
		got := mergeOperator(current, nil)
		if got != current {
			t.Fatal("patch nil should return current unchanged")
		}
	})

	t.Run("current nil returns patch", func(t *testing.T) {
		patch := &Operator{UserName: Str("bob"), UserEmail: Str("bob@example.com")}
		got := mergeOperator(nil, patch)
		if got != patch {
			t.Fatal("current nil should return patch")
		}
	})

	t.Run("patch username replaces current", func(t *testing.T) {
		current := &Operator{UserName: Str("alice"), UserEmail: Str("alice@example.com")}
		patch := &Operator{UserName: Str("bob")}
		got := mergeOperator(current, patch)
		if *got.UserName != "bob" {
			t.Fatalf("username = %q, want bob", *got.UserName)
		}
		if *got.UserEmail != "alice@example.com" {
			t.Fatalf("email = %q, want alice@example.com", *got.UserEmail)
		}
	})

	t.Run("patch email nil keeps current email", func(t *testing.T) {
		current := &Operator{UserName: Str("alice"), UserEmail: Str("alice@example.com")}
		patch := &Operator{UserName: Str("bob")}
		got := mergeOperator(current, patch)
		if *got.UserEmail != "alice@example.com" {
			t.Fatalf("email = %q, want alice@example.com", *got.UserEmail)
		}
	})

	t.Run("both fields in patch override current", func(t *testing.T) {
		current := &Operator{UserName: Str("alice"), UserEmail: Str("alice@example.com")}
		patch := &Operator{UserName: Str("bob"), UserEmail: Str("bob@example.com")}
		got := mergeOperator(current, patch)
		if *got.UserName != "bob" || *got.UserEmail != "bob@example.com" {
			t.Fatalf("operator = %+v, want bob/bob@example.com", got)
		}
	})

	t.Run("empty patch keeps current", func(t *testing.T) {
		current := &Operator{UserName: Str("alice"), UserEmail: Str("alice@example.com")}
		patch := &Operator{}
		got := mergeOperator(current, patch)
		if *got.UserName != "alice" || *got.UserEmail != "alice@example.com" {
			t.Fatalf("empty patch should keep current: %+v", got)
		}
	})
}

func TestMergeIdentity(t *testing.T) {
	t.Run("patch nil keeps current", func(t *testing.T) {
		current := &GitIdentity{UserName: Str("alice"), UserEmail: Str("alice@example.com")}
		got := mergeIdentity(current, nil)
		if got != current {
			t.Fatal("patch nil should return current unchanged")
		}
	})

	t.Run("current nil returns patch", func(t *testing.T) {
		patch := &GitIdentity{UserName: Str("bob"), UserEmail: Str("bob@example.com")}
		got := mergeIdentity(nil, patch)
		if got != patch {
			t.Fatal("current nil should return patch")
		}
	})

	t.Run("patch username replaces current", func(t *testing.T) {
		current := &GitIdentity{UserName: Str("alice"), UserEmail: Str("alice@example.com")}
		patch := &GitIdentity{UserName: Str("bob")}
		got := mergeIdentity(current, patch)
		if *got.UserName != "bob" {
			t.Fatalf("username = %q, want bob", *got.UserName)
		}
		if *got.UserEmail != "alice@example.com" {
			t.Fatalf("email = %q, want alice@example.com", *got.UserEmail)
		}
	})

	t.Run("empty patch keeps current", func(t *testing.T) {
		current := &GitIdentity{UserName: Str("alice"), UserEmail: Str("alice@example.com")}
		patch := &GitIdentity{}
		got := mergeIdentity(current, patch)
		if *got.UserName != "alice" || *got.UserEmail != "alice@example.com" {
			t.Fatalf("empty patch should keep current: %+v", got)
		}
	})
}

func TestMergePm(t *testing.T) {
	t.Run("patch nil keeps current", func(t *testing.T) {
		current := &PackageManagerConfig{Name: Str("npm"), Path: Str(".")}
		got := mergePm(current, nil)
		if got != current {
			t.Fatal("patch nil should return current unchanged")
		}
	})

	t.Run("current nil returns patch", func(t *testing.T) {
		patch := &PackageManagerConfig{Name: Str("pnpm"), Path: Str(".")}
		got := mergePm(nil, patch)
		if got != patch {
			t.Fatal("current nil should return patch")
		}
	})

	t.Run("patch name replaces current", func(t *testing.T) {
		current := &PackageManagerConfig{Name: Str("npm"), Path: Str(".")}
		patch := &PackageManagerConfig{Name: Str("bun")}
		got := mergePm(current, patch)
		if *got.Name != "bun" {
			t.Fatalf("name = %q, want bun", *got.Name)
		}
		if *got.Path != "." {
			t.Fatalf("path = %q, want .", *got.Path)
		}
	})

	t.Run("patch path nil keeps current path", func(t *testing.T) {
		current := &PackageManagerConfig{Name: Str("npm"), Path: Str("./packages")}
		patch := &PackageManagerConfig{Name: Str("pnpm")}
		got := mergePm(current, patch)
		if *got.Path != "./packages" {
			t.Fatalf("path = %q, want ./packages", *got.Path)
		}
	})

	t.Run("both fields in patch override current", func(t *testing.T) {
		current := &PackageManagerConfig{Name: Str("npm"), Path: Str(".")}
		patch := &PackageManagerConfig{Name: Str("bun"), Path: Str("./build")}
		got := mergePm(current, patch)
		if *got.Name != "bun" || *got.Path != "./build" {
			t.Fatalf("pm = %+v, want bun/./build", got)
		}
	})
}

func TestMergeApplication(t *testing.T) {
	t.Run("patch nil keeps current", func(t *testing.T) {
		current := &Application{
			PackageManager: &PackageManagerConfig{Name: Str("npm")},
			Runtime:        Str("node"),
			Port:           Ptr(3000.0),
		}
		got := mergeApplication(current, nil)
		if got != current {
			t.Fatal("patch nil should return current unchanged")
		}
	})

	t.Run("current nil returns patch", func(t *testing.T) {
		patch := &Application{Runtime: Str("bun")}
		got := mergeApplication(nil, patch)
		if got != patch {
			t.Fatal("current nil should return patch")
		}
	})

	t.Run("patch runtime replaces current", func(t *testing.T) {
		current := &Application{Runtime: Str("node"), Port: Ptr(3000.0)}
		patch := &Application{Runtime: Str("bun")}
		got := mergeApplication(current, patch)
		if *got.Runtime != "bun" {
			t.Fatalf("runtime = %q, want bun", *got.Runtime)
		}
		if got.Port == nil || *got.Port != 3000.0 {
			t.Fatalf("port = %v, want 3000", got.Port)
		}
	})

	t.Run("patch port replaces current", func(t *testing.T) {
		current := &Application{Runtime: Str("node"), Port: Ptr(3000.0)}
		patch := &Application{Port: Ptr(8000.0)}
		got := mergeApplication(current, patch)
		if *got.Port != 8000.0 {
			t.Fatalf("port = %v, want 8000", *got.Port)
		}
		if *got.Runtime != "node" {
			t.Fatalf("runtime = %q, want node", *got.Runtime)
		}
	})

	t.Run("patch packageManager merges nested", func(t *testing.T) {
		current := &Application{
			PackageManager: &PackageManagerConfig{Name: Str("npm"), Path: Str(".")},
			Runtime:        Str("node"),
		}
		patch := &Application{PackageManager: &PackageManagerConfig{Name: Str("pnpm")}}
		got := mergeApplication(current, patch)
		if *got.PackageManager.Name != "pnpm" {
			t.Fatalf("pm name = %q, want pnpm", *got.PackageManager.Name)
		}
		if *got.PackageManager.Path != "." {
			t.Fatalf("pm path = %q, want .", *got.PackageManager.Path)
		}
		if *got.Runtime != "node" {
			t.Fatalf("runtime = %q, want node", *got.Runtime)
		}
	})

	t.Run("empty patch keeps current", func(t *testing.T) {
		current := &Application{Runtime: Str("node"), Port: Ptr(3000.0)}
		patch := &Application{}
		got := mergeApplication(current, patch)
		if *got.Runtime != "node" || *got.Port != 3000.0 {
			t.Fatalf("empty patch should keep current: %+v", got)
		}
	})
}

// Ptr is a helper to create a pointer to a float64.
func Ptr(f float64) *float64 {
	return &f
}
