package content

// Uploads beside the protocol, ported from server/assets.ts and assets.ts:
// `PUT …/assets/<name>` with the file's own image, video, font or PDF type;
// the name's extension must match it, SVG is refused, a taken name gets a
// short suffix, and the answer is the path the field stores: /assets/<name>.

import (
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/text/unicode/norm"
)

var assetTypes = map[string][]string{
	"image/png":                     {".png"},
	"image/jpeg":                    {".jpg", ".jpeg"},
	"image/webp":                    {".webp"},
	"image/avif":                    {".avif"},
	"image/gif":                     {".gif"},
	"image/x-icon":                  {".ico"},
	"image/vnd.microsoft.icon":      {".ico"},
	"video/mp4":                     {".mp4"},
	"video/webm":                    {".webm"},
	"font/woff2":                    {".woff2"},
	"font/woff":                     {".woff"},
	"font/ttf":                      {".ttf"},
	"font/otf":                      {".otf"},
	"application/font-woff":         {".woff"},
	"application/x-font-ttf":        {".ttf"},
	"application/vnd.ms-fontobject": {".eot"},
	"application/pdf":               {".pdf"},
}

func mediaType(contentType string) string {
	return strings.ToLower(strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0]))
}

func assetExtensions(contentType string, present bool) []string {
	if !present {
		return nil
	}
	return assetTypes[mediaType(contentType)]
}

// assetNameForType fits a sanitized name to its type: a name without an
// extension gets the type's; "" when the extension doesn't match.
func assetNameForType(name string, extensions []string) string {
	if extensions == nil {
		return ""
	}
	dot := strings.LastIndex(name, ".")
	if dot <= 0 {
		return name + extensions[0]
	}
	ext := strings.ToLower(name[dot:])
	for _, e := range extensions {
		if e == ext {
			return name[:dot] + ext
		}
	}
	return ""
}

var (
	combiningMarks  = regexp.MustCompile("[̀-ͯ]")
	notNameChars    = regexp.MustCompile(`[^A-Za-z0-9._-]+`)
	repeatedDashes  = regexp.MustCompile(`-{2,}`)
	leadingDotsDash = regexp.MustCompile(`^[.-]+`)
	dashBeforeDot   = regexp.MustCompile(`-+(\.|$)`)
)

// sanitizeAssetName normalizes an upload's name: its last path segment, with
// anything but letters, digits, ".", "_" and "-" replaced; "" when nothing
// usable is left.
func sanitizeAssetName(raw string) string {
	name, ok := decodeURIComponent(raw)
	if !ok {
		name = raw
	}
	if i := strings.LastIndexAny(name, `\/`); i >= 0 {
		name = name[i+1:]
	}
	name = norm.NFKD.String(name)
	name = combiningMarks.ReplaceAllString(name, "")
	name = notNameChars.ReplaceAllString(name, "-")
	name = repeatedDashes.ReplaceAllString(name, "-")
	name = leadingDotsDash.ReplaceAllString(name, "")
	name = dashBeforeDot.ReplaceAllString(name, "$1")
	if name == "" || name == "." || name == ".." {
		return ""
	}
	if len(name) > 200 {
		ext := ""
		if dot := strings.LastIndex(name, "."); dot > 0 {
			ext = name[dot:]
			if len(ext) > 16 {
				ext = ext[:16]
			}
		}
		name = name[:200-len(ext)] + ext
	}
	return name
}

var assetErrorStatus = map[int]int{
	CodeReadOnly:       403,
	CodeUnsupported:    404,
	CodeLimitExceeded:  413,
	CodeInvalidRequest: 400,
}

func (h *Handler) assetFail(w http.ResponseWriter, r *http.Request, e *ProtocolError, status int) {
	if status == 0 {
		status = assetErrorStatus[e.Code]
		if status == 0 {
			status = 400
		}
	}
	writeJSON(w, r, Stringify(NewObject("error", e.JSON()), 0), status, nil)
}

// ServeAssets serves `PUT …/assets/<name>`.
func (h *Handler) ServeAssets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		writeJSON(w, r, Stringify(NewObject("error", errInvalidRequest("use PUT").JSON()), 0), 405, map[string]string{"Allow": "PUT"})
		return
	}
	desc := h.store.describe()
	contentType := strings.Join(r.Header.Values("Content-Type"), ", ")
	extensions := assetExtensions(contentType, len(r.Header.Values("Content-Type")) > 0)
	if extensions == nil {
		h.assetFail(w, r, errInvalidRequest("uploads must be an image, video, font or PDF"), 415)
		return
	}
	path := r.URL.EscapedPath()
	sanitized := ""
	if marker := strings.LastIndex(path, assetsURLPrefix); marker >= 0 {
		sanitized = sanitizeAssetName(path[marker+len(assetsURLPrefix):])
	}
	if sanitized == "" {
		h.assetFail(w, r, errInvalidRequest("PUT /assets/<name> needs a file name"), 0)
		return
	}
	name := assetNameForType(sanitized, extensions)
	if name == "" {
		h.assetFail(w, r, errInvalidRequest("the file name's extension doesn't match its content type ("+contentType+")"), 415)
		return
	}
	body, err := readBody(r, desc.AssetsMaxBytes)
	if err != nil {
		var enc *bodyEncodingError
		switch {
		case errors.Is(err, errBodyTooLarge):
			h.assetFail(w, r, errLimitExceeded("uploads are limited to "+strconv.FormatInt(desc.AssetsMaxBytes, 10)+" bytes", nil), 0)
		case errors.As(err, &enc):
			h.assetFail(w, r, errInvalidRequest(enc.msg), 415)
		default:
			h.assetFail(w, r, errInternal(), 500)
		}
		return
	}
	if len(body) == 0 {
		h.assetFail(w, r, errInvalidRequest("the upload is empty"), 0)
		return
	}
	stored, err := h.store.putAsset(name, body)
	if err != nil {
		// OPEN: the TS handler lets this throw (its server answers 500).
		h.logf("content protocol: upload failed: %v", err)
		h.assetFail(w, r, errInternal(), 500)
		return
	}
	if h.onAsset != nil {
		h.onAsset(stored)
	}
	writeJSON(w, r, Stringify(NewObject("path", assetsURLPrefix+stored), 0), 201, nil)
}
