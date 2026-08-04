package events

type ReplayBuffer struct {
	maxBytes int
	order    []string
	buffers  map[string][]byte
}

func NewReplayBuffer(maxBytes int) *ReplayBuffer {
	return &ReplayBuffer{maxBytes: maxBytes, buffers: map[string][]byte{}}
}

// Append grows the source's buffer in place (amortized O(len(data)) via
// Go's slice growth) instead of reallocating and copying up to maxBytes on
// every call, which mattered here since BroadcastChunk holds Broadcaster.mu
// while appending on every log chunk.
func (r *ReplayBuffer) Append(source, data string) {
	if data == "" {
		return
	}
	buf, ok := r.buffers[source]
	if !ok {
		r.order = append(r.order, source)
	}
	buf = append(buf, data...)
	if len(buf) > r.maxBytes {
		buf = buf[len(buf)-r.maxBytes:]
	}
	r.buffers[source] = buf
}

func (r *ReplayBuffer) Read(source string) string {
	return string(r.buffers[source])
}

func (r *ReplayBuffer) Sources() []string {
	out := make([]string, len(r.order))
	copy(out, r.order)
	return out
}
