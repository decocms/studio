package proxy

import (
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

func IsWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

type WsDeps struct {
	GetDevPort func() int
	// OnClientData bumps activity on client → upstream traffic.
	OnClientData func()
}

// ServeWs proxies a WebSocket upgrade by splicing raw TCP bytes between the
// client and the dev server. The upgrade request is forwarded verbatim
// (subprotocols included); upstream closes propagate as FIN.
func ServeWs(w http.ResponseWriter, r *http.Request, deps WsDeps) {
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "Upgrade failed", http.StatusBadRequest)
		return
	}
	port := deps.GetDevPort()
	clientConn, clientBuf, err := hj.Hijack()
	if err != nil {
		return
	}
	defer clientConn.Close()

	// A failure to reach the dev server is reported as a WebSocket close, not an
	// HTTP error: by the time the browser has sent an upgrade it only surfaces
	// close codes, and a 502 on the upgrade reads as a protocol error (1002).
	if port == 0 {
		if completeHandshake(clientConn, r) == nil {
			sendClose(clientConn, 1011, "no upstream dev server")
		}
		return
	}

	upstream, err := dialLoopbackTCP(port)
	if err != nil {
		if completeHandshake(clientConn, r) == nil {
			sendClose(clientConn, 1011, "upstream not reachable")
		}
		return
	}
	defer upstream.Close()

	if err := writeUpgradeRequest(upstream, r); err != nil {
		return
	}

	done := make(chan struct{}, 2)
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, rerr := clientBuf.Read(buf)
			if n > 0 {
				if deps.OnClientData != nil {
					deps.OnClientData()
				}
				if _, werr := upstream.Write(buf[:n]); werr != nil {
					break
				}
			}
			if rerr != nil {
				break
			}
		}
		if tcp, ok := upstream.(*net.TCPConn); ok {
			tcp.CloseWrite()
		}
		done <- struct{}{}
	}()
	go func() {
		io.Copy(clientConn, upstream)
		if tcp, ok := clientConn.(*net.TCPConn); ok {
			tcp.CloseWrite()
		}
		done <- struct{}{}
	}()
	<-done
	<-done
}

func dialLoopbackTCP(port int) (net.Conn, error) {
	conn, err := net.Dial("tcp", net.JoinHostPort("::1", strconv.Itoa(port)))
	if err == nil {
		return conn, nil
	}
	return net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
}

func writeUpgradeRequest(upstream net.Conn, r *http.Request) error {
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s HTTP/1.1\r\n", r.Method, r.URL.RequestURI())
	fmt.Fprintf(&b, "Host: %s\r\n", r.Host)
	for k, vv := range r.Header {
		if strings.EqualFold(k, "Host") {
			continue
		}
		for _, v := range vv {
			fmt.Fprintf(&b, "%s: %s\r\n", k, v)
		}
	}
	b.WriteString("\r\n")
	_, err := upstream.Write([]byte(b.String()))
	return err
}

// completeHandshake answers the client's upgrade with a 101 so the connection
// becomes a real WebSocket — the "connect then close" contract, which lets the
// daemon report an upstream problem as a close code instead of a 4xx/5xx.
func completeHandshake(conn net.Conn, r *http.Request) error {
	key := r.Header.Get("Sec-Websocket-Key")
	if key == "" {
		conn.Write([]byte("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"))
		return fmt.Errorf("missing Sec-WebSocket-Key")
	}
	h := sha1.New()
	io.WriteString(h, key+wsGUID)
	accept := base64.StdEncoding.EncodeToString(h.Sum(nil))
	var b strings.Builder
	b.WriteString("HTTP/1.1 101 Switching Protocols\r\n")
	b.WriteString("Upgrade: websocket\r\nConnection: Upgrade\r\n")
	fmt.Fprintf(&b, "Sec-WebSocket-Accept: %s\r\n", accept)
	if protos := r.Header.Get("Sec-Websocket-Protocol"); protos != "" {
		first := strings.TrimSpace(strings.Split(protos, ",")[0])
		if first != "" {
			fmt.Fprintf(&b, "Sec-WebSocket-Protocol: %s\r\n", first)
		}
	}
	b.WriteString("\r\n")
	_, err := conn.Write([]byte(b.String()))
	return err
}

// sendClose writes an unmasked server close frame carrying `code` and `reason`.
// Payloads stay well under 125 bytes, so the 7-bit length form always applies.
func sendClose(conn net.Conn, code uint16, reason string) {
	payload := make([]byte, 2, 2+len(reason))
	payload[0] = byte(code >> 8)
	payload[1] = byte(code)
	payload = append(payload, reason...)
	if len(payload) > 125 {
		payload = payload[:125]
	}
	frame := append([]byte{0x88, byte(len(payload))}, payload...)
	conn.Write(frame)
}
