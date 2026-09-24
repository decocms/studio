package main

import (
	"maps"
	"testing"
)

func TestParseDockerImages(t *testing.T) {
	for _, tc := range []struct {
		name, image, variants string
		want                  map[string]string
	}{
		{name: "default only", image: "studio-sandbox:1", want: map[string]string{"default": "studio-sandbox:1"}},
		{name: "variants", image: "d:1", variants: " android=a:1 , flutter=ghcr.io/x/f:2,", want: map[string]string{"default": "d:1", "android": "a:1", "flutter": "ghcr.io/x/f:2"}},
		{name: "no default image", variants: "android=a:1"},
		{name: "not name=image", image: "d:1", variants: "android"},
		{name: "empty image", image: "d:1", variants: "android="},
		{name: "a name the repository field cannot hold", image: "d:1", variants: "Android=a:1"},
		{name: "default is not a variant", image: "d:1", variants: "default=x:1"},
		{name: "duplicate", image: "d:1", variants: "android=a:1,android=a:2"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseDockerImages(tc.image, tc.variants)
			if tc.want == nil {
				if err == nil {
					t.Fatalf("accepted: %v", got)
				}
				return
			}
			if err != nil || !maps.Equal(got, tc.want) {
				t.Fatalf("got %v, %v; want %v", got, err, tc.want)
			}
		})
	}
}
