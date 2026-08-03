package httpx

import (
	"encoding/json"
	"net/http"
)

func JSON(w http.ResponseWriter, status int, body any) {
	data, err := json.Marshal(body)
	if err != nil {
		data = []byte(`{"error":"internal marshal failure"}`)
		status = 500
	}
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(status)
	w.Write(data)
}

func Error(w http.ResponseWriter, status int, msg string) {
	JSON(w, status, map[string]string{"error": msg})
}
