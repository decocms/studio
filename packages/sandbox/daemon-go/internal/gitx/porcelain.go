package gitx

import "strings"

type PorcelainFile struct {
	Path       string `json:"path"`
	Index      string `json:"index"`
	WorkingDir string `json:"working_dir"`
}

func parsePorcelainEntry(entry string) (PorcelainFile, bool) {
	if len(entry) < 3 {
		return PorcelainFile{}, false
	}
	index := string(entry[0])
	working := string(entry[1])
	var path string
	if len(entry) >= 4 && entry[2] == ' ' {
		path = entry[3:]
	} else {
		path = entry[2:]
	}
	if path == "" {
		return PorcelainFile{}, false
	}
	return PorcelainFile{Path: path, Index: index, WorkingDir: working}, true
}

func ParsePorcelainFiles(out string) []PorcelainFile {
	files := []PorcelainFile{}
	parts := strings.Split(out, "\x00")
	for i := 0; i < len(parts); i++ {
		entry := parts[i]
		if entry == "" {
			continue
		}
		parsed, ok := parsePorcelainEntry(entry)
		if !ok {
			continue
		}
		files = append(files, parsed)
		if parsed.Index == "R" || parsed.Index == "C" {
			i++
		}
	}
	return files
}

func ParsePorcelainZ(out string) map[string]struct{} {
	paths := map[string]struct{}{}
	parts := strings.Split(out, "\x00")
	for i := 0; i < len(parts); i++ {
		entry := parts[i]
		if entry == "" {
			continue
		}
		parsed, ok := parsePorcelainEntry(entry)
		if !ok {
			continue
		}
		paths[parsed.Path] = struct{}{}
		if parsed.Index == "R" || parsed.Index == "C" {
			i++
			if i < len(parts) && parts[i] != "" {
				paths[parts[i]] = struct{}{}
			}
		}
	}
	return paths
}
