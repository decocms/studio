# Build context: packages/sandbox (the controller imports daemon-go/pkg/protocol
# through a replace directive).
FROM --platform=$BUILDPLATFORM golang:1.25-bookworm AS build
ARG TARGETOS TARGETARCH
WORKDIR /src/controller-go
COPY daemon-go/go.mod daemon-go/go.sum ../daemon-go/
COPY daemon-go/pkg ../daemon-go/pkg
COPY controller-go/go.mod controller-go/go.sum ./
RUN go mod download
COPY controller-go/ ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/sandbox-controller .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/sandbox-controller /sandbox-controller
USER 65532:65532
ENTRYPOINT ["/sandbox-controller"]
