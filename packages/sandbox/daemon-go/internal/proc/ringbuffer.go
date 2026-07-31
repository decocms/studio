package proc

import "sync"

type RingBuffer struct {
	mu       sync.Mutex
	chunks   []string
	size     int
	dropped  bool
	capacity int
}

func NewRingBuffer(capacity int) *RingBuffer {
	return &RingBuffer{capacity: capacity}
}

func (r *RingBuffer) Append(data string) {
	if data == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.chunks = append(r.chunks, data)
	r.size += len(data)
	for r.size > r.capacity && len(r.chunks) > 0 {
		head := r.chunks[0]
		if r.size-len(head) >= r.capacity {
			r.chunks = r.chunks[1:]
			r.size -= len(head)
			r.dropped = true
			continue
		}
		overflow := r.size - r.capacity
		r.chunks[0] = head[overflow:]
		r.size -= overflow
		r.dropped = true
		break
	}
}

func (r *RingBuffer) Read() (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out string
	for _, c := range r.chunks {
		out += c
	}
	return out, r.dropped
}
