package events

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

func SseFormat(event, payload string) []byte {
	return []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", event, payload))
}

func SseFrame(event string, payload any) []byte {
	data, err := json.Marshal(payload)
	if err != nil {
		data = []byte("{}")
	}
	return SseFormat(event, string(data))
}

const clientBufferFrames = 1024

type Client struct {
	Ch     chan []byte
	closed bool
}

type Broadcaster struct {
	mu      sync.Mutex
	clients map[*Client]struct{}
	Replay  *ReplayBuffer
	Verbose bool
	// ChunkObserver is invoked on every BroadcastChunk before fan-out
	// (port-sniffer tap; entry.ts monkey-patch made explicit).
	ChunkObserver func(source, data string)
}

func NewBroadcaster(replayBytes int) *Broadcaster {
	return &Broadcaster{
		clients: map[*Client]struct{}{},
		Replay:  NewReplayBuffer(replayBytes),
		Verbose: os.Getenv("DAEMON_LOG_VERBOSE") == "1",
	}
}

func (b *Broadcaster) Register() *Client {
	c := &Client{Ch: make(chan []byte, clientBufferFrames)}
	b.mu.Lock()
	b.clients[c] = struct{}{}
	b.mu.Unlock()
	return c
}

func (b *Broadcaster) Unregister(c *Client) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.remove(c)
}

func (b *Broadcaster) remove(c *Client) {
	if _, ok := b.clients[c]; !ok {
		return
	}
	delete(b.clients, c)
	if !c.closed {
		c.closed = true
		close(c.Ch)
	}
}

func (b *Broadcaster) Size() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.clients)
}

type ChunkOpts struct {
	Tee bool
}

func (b *Broadcaster) BroadcastChunk(source, data string, opts ...ChunkOpts) {
	if data == "" {
		return
	}
	tee := true
	if len(opts) > 0 {
		tee = opts[0].Tee
	}
	if b.ChunkObserver != nil {
		b.ChunkObserver(source, data)
	}
	b.mu.Lock()
	b.Replay.Append(source, data)
	b.mu.Unlock()
	if b.Verbose || tee {
		fmt.Fprintf(os.Stdout, "[%s] %s", source, data)
	}
	payload, _ := json.Marshal(map[string]string{"source": source, "data": data})
	b.fan(SseFormat("log", string(payload)))
}

func (b *Broadcaster) Emit(name string, payload any) {
	b.fan(SseFrame(name, payload))
}

func (b *Broadcaster) fan(bytes []byte) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var dead []*Client
	for c := range b.clients {
		select {
		case c.Ch <- bytes:
		default:
			dead = append(dead, c)
		}
	}
	for _, c := range dead {
		b.remove(c)
	}
}

// ReplaySnapshot returns sources in insertion order with their buffers,
// captured atomically for the SSE handshake.
func (b *Broadcaster) ReplaySnapshot() []struct{ Source, Data string } {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []struct{ Source, Data string }
	for _, src := range b.Replay.Sources() {
		buf := b.Replay.Read(src)
		if buf != "" {
			out = append(out, struct{ Source, Data string }{src, buf})
		}
	}
	return out
}
