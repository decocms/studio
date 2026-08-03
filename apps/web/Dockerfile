# The nginx image serves ONLY the prebuilt SPA assets, so it needs neither the
# Bun runtime nor a dependency install. The release build stages apps/web/dist
# into apps/api/dist/client before packing the combined distribution. We then
# extract that dist/client straight out of the tarball (npm pack lays every file
# under package/). This also keeps the image independent of the Bun runtime and
# server-side dependencies.
FROM alpine:3.20 AS bundle

WORKDIR /src
COPY decocms.tgz /tmp/decocms.tgz
RUN tar -xzf /tmp/decocms.tgz -C /src

FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY --from=bundle /src/package/dist/client/ /usr/share/nginx/html/
COPY deploy/helm/studio/files/api-nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080
