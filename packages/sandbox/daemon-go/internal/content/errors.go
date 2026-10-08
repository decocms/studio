package content

import "strconv"

// Error codes: JSON-RPC 2.0's, then the content protocol's. Ported from
// `@decocms/blocks/protocol` errors.ts.
const (
	CodeParseError     = -32700
	CodeInvalidRequest = -32600
	CodeMethodNotFound = -32601
	CodeInvalidParams  = -32602
	CodeInternalError  = -32603
	CodeNotFound       = -32001
	CodeConflict       = -32002
	CodeInvalidBlock   = -32003
	CodeReadOnly       = -32005
	CodeUnsupported    = -32006
	CodeLimitExceeded  = -32007
	CodeUnavailable    = -32008
)

// ProtocolError is a method failure: the JSON-RPC `error` object.
type ProtocolError struct {
	Code    int
	Message string
	Data    any // nil: no `data` member
}

func (e *ProtocolError) Error() string { return e.Message }

// JSON is the error object, `{code, message, data?}`.
func (e *ProtocolError) JSON() *Object {
	o := NewObject("code", float64(e.Code), "message", e.Message)
	if e.Data != nil {
		o.Set("data", e.Data)
	}
	return o
}

// Violation is one rule a blocks.apply breaks.
type Violation struct {
	Name    string
	Pointer *string // set for a violation about one value
	Rule    string
	Message string
}

func (v Violation) json() *Object {
	o := NewObject("name", v.Name)
	if v.Pointer != nil {
		o.Set("pointer", *v.Pointer)
	}
	o.Set("rule", v.Rule)
	o.Set("message", v.Message)
	return o
}

func errNotFound(message string) *ProtocolError {
	return &ProtocolError{Code: CodeNotFound, Message: message}
}

func errConflict(entries *Object) *ProtocolError {
	return &ProtocolError{Code: CodeConflict, Message: "a precondition failed", Data: NewObject("entries", entries)}
}

func errInvalidBlock(violations []Violation) *ProtocolError {
	message := strconv.Itoa(len(violations)) + " invalid blocks"
	if len(violations) == 1 {
		message = `invalid block "` + violations[0].Name + `": ` + violations[0].Message
	}
	list := make([]any, len(violations))
	for i, v := range violations {
		list[i] = v.json()
	}
	return &ProtocolError{Code: CodeInvalidBlock, Message: message, Data: NewObject("violations", list)}
}

func errReadOnly() *ProtocolError {
	return &ProtocolError{Code: CodeReadOnly, Message: "this endpoint is read-only"}
}

func errUnsupported(message string) *ProtocolError {
	return &ProtocolError{Code: CodeUnsupported, Message: message}
}

func errLimitExceeded(message string, data *Object) *ProtocolError {
	e := &ProtocolError{Code: CodeLimitExceeded, Message: message}
	if data != nil {
		e.Data = data
	}
	return e
}

func errUnavailable(message string, retryAfterMs int) *ProtocolError {
	e := &ProtocolError{Code: CodeUnavailable, Message: message}
	if retryAfterMs >= 0 {
		e.Data = NewObject("retryAfterMs", float64(retryAfterMs))
	}
	return e
}

func errInvalidParams(message string) *ProtocolError {
	return &ProtocolError{Code: CodeInvalidParams, Message: message}
}

func errInvalidRequest(message string) *ProtocolError {
	return &ProtocolError{Code: CodeInvalidRequest, Message: message}
}

func errMethodNotFound(method string) *ProtocolError {
	return &ProtocolError{Code: CodeMethodNotFound, Message: `unknown method "` + method + `"`}
}

func errParse() *ProtocolError {
	return &ProtocolError{Code: CodeParseError, Message: "invalid JSON"}
}

func errInternal() *ProtocolError {
	return &ProtocolError{Code: CodeInternalError, Message: "internal error"}
}
