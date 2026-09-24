FROM --platform=$BUILDPLATFORM golang:1.25-bookworm AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/sandbox-controller .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/sandbox-controller /sandbox-controller
USER 65532:65532
ENTRYPOINT ["/sandbox-controller"]
