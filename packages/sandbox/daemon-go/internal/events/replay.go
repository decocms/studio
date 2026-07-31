package events

type ReplayBuffer struct {
	maxBytes int
	order    []string
	buffers  map[string]string
}

func NewReplayBuffer(maxBytes int) *ReplayBuffer {
	return &ReplayBuffer{maxBytes: maxBytes, buffers: map[string]string{}}
}

func (r *ReplayBuffer) Append(source, data string) {
	if data == "" {
		return
	}
	prev, ok := r.buffers[source]
	if !ok {
		r.order = append(r.order, source)
	}
	next := prev + data
	if len(next) > r.maxBytes {
		next = next[len(next)-r.maxBytes:]
	}
	r.buffers[source] = next
}

func (r *ReplayBuffer) Read(source string) string {
	return r.buffers[source]
}

func (r *ReplayBuffer) Sources() []string {
	out := make([]string, len(r.order))
	copy(out, r.order)
	return out
}
