# HestiaCP Nginx-Proxy-Template (HTTP) -> /usr/local/hestia/data/templates/web/nginx/projecttemplate.tpl
# Leitet auf HTTPS um.
server {
    listen      %ip%:%proxy_port%;
    server_name %domain_idn% %alias_idn%;

    include %home%/%user%/conf/web/%domain%/nginx.forcessl.conf*;

    location / {
        return 301 https://%domain_idn%$request_uri;
    }

    location /error/ {
        alias   %home%/%user%/web/%domain%/document_errors/;
    }
}
