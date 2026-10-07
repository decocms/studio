package content

// The JSON-RPC 2.0 layer, ported from server/rpc.ts: every request needs an
// id; a batch runs in order, holds at most 10 calls and isn't atomic.

import (
	"errors"
	"strings"
)

const maxBatchCalls = 10

var methodNames = map[string]bool{"describe": true, "schema.get": true, "blocks.list": true, "blocks.apply": true}

var envelopeMembers = map[string]bool{"jsonrpc": true, "id": true, "method": true, "params": true}

type envelope struct {
	id        any // string or float64
	method    string
	params    any
	hasParams bool
}

func parseEnvelope(value any) (*envelope, *ProtocolError, any) {
	raw, isObject := asObject(value)
	var id any
	if raw != nil {
		switch v := prop(raw, "id").(type) {
		case string, float64:
			id = v
		}
	}
	if !isObject {
		return nil, errInvalidRequest("a request must be an object"), nil
	}
	if jsonrpc, ok := prop(raw, "jsonrpc").(string); !ok || jsonrpc != "2.0" {
		return nil, errInvalidRequest(`jsonrpc must be "2.0"`), id
	}
	if id == nil {
		return nil, errInvalidRequest("every request needs a string or number id"), nil
	}
	method, ok := prop(raw, "method").(string)
	if !ok {
		return nil, errInvalidRequest("method must be a string"), id
	}
	for _, key := range raw.Keys() {
		if !envelopeMembers[key] {
			return nil, errInvalidRequest(`unknown request member "` + key + `"`), id
		}
	}
	if !methodNames[method] {
		return nil, errMethodNotFound(method), id
	}
	params, has := raw.Get("params")
	return &envelope{id: id, method: method, params: params, hasParams: has}, nil, id
}

func errorResponse(id any, e *ProtocolError) string {
	return Stringify(NewObject("jsonrpc", "2.0", "id", id, "error", e.JSON()), 0)
}

// toProtocolError maps storage errors to protocol errors; nil for unknown ones.
func toProtocolError(err error) *ProtocolError {
	var pe *ProtocolError
	var nf *storageNotFound
	var inv *storageInvalidFile
	var un *storageUnavailable
	switch {
	case errors.As(err, &pe):
		return pe
	case errors.As(err, &nf):
		return errNotFound(nf.msg)
	case errors.As(err, &inv):
		name := BlockNameFromFile(inv.file)
		return errInvalidBlock([]Violation{{Name: name, Rule: "unsupported-name", Message: `this storage can't hold the entry "` + name + `"`}})
	case errors.As(err, &un):
		return errUnavailable(un.msg, un.retryAfterMs)
	}
	return nil
}

func (h *Handler) run(e *envelope) (any, error) {
	if perr := validateParams(e.method, e.params, e.hasParams); perr != nil {
		return nil, perr
	}
	switch e.method {
	case "describe":
		return h.describe()
	case "schema.get":
		return h.schemaGet(e.params)
	case "blocks.list":
		return h.blocksList(e.params)
	default:
		return h.blocksApply(e.params)
	}
}

func (h *Handler) call(value any) (out string) {
	e, perr, id := parseEnvelope(value)
	if perr != nil {
		return errorResponse(id, perr)
	}
	defer func() {
		// An unexpected throw (a URIError from a lone surrogate, a bug) is an
		// Internal error for this call only, as in the TS server.
		if r := recover(); r != nil {
			if _, isURI := r.(uriError); !isURI {
				h.logf("content protocol: %s panicked: %v", e.method, r)
			}
			out = errorResponse(e.id, errInternal())
		}
	}()
	result, err := h.run(e)
	if err != nil {
		if known := toProtocolError(err); known != nil {
			return errorResponse(e.id, known)
		}
		h.logf("content protocol: %s failed: %v", e.method, err)
		return errorResponse(e.id, errInternal())
	}
	return Stringify(NewObject("jsonrpc", "2.0", "id", e.id, "result", result), 0)
}

// dispatch runs a parsed body (one request or a batch) and returns the
// serialized response body.
func (h *Handler) dispatch(body any) string {
	list, isBatch := body.([]any)
	if !isBatch {
		return h.call(body)
	}
	if len(list) == 0 {
		return errorResponse(nil, errInvalidRequest("an empty batch"))
	}
	if len(list) > maxBatchCalls {
		return errorResponse(nil, errLimitExceeded("a batch holds at most 10 calls", NewObject("limit", "maxBatchCalls")))
	}
	parts := make([]string, len(list))
	for i, item := range list {
		parts[i] = h.call(item)
	}
	return "[" + strings.Join(parts, ",") + "]"
}
