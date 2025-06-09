#!/bin/bash
set -e

DOMAIN="streamhub.sofe.site"
EMAIL="admin@sofe.site"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_status() { echo -e "${GREEN}[✓]${NC} $1"; }
print_error() { echo -e "${RED}[✗]${NC} $1"; }
print_info() { echo -e "${YELLOW}[i]${NC} $1"; }

if [[ $EUID -ne 0 ]]; then
   print_error "Este script debe ejecutarse como root"
   exit 1
fi

print_info "Configurando SSL para ${DOMAIN}..."

# 1. Instalar certbot si no está
print_info "Instalando certbot..."
apt-get update
apt-get install -y certbot python3-certbot-nginx

# 2. Detener NGINX
print_info "Deteniendo NGINX..."
systemctl stop nginx-rtmp || true

# 3. Obtener certificado
print_info "Obteniendo certificado SSL..."
certbot certonly --standalone -d ${DOMAIN} --non-interactive --agree-tos --email ${EMAIL} --force-renewal

if [ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
    print_error "Error al obtener certificado SSL"
    exit 1
fi

print_status "Certificado SSL obtenido"

# 4. Crear configuración NGINX con SSL
print_info "Configurando NGINX con SSL..."
cat > /usr/local/nginx/conf/nginx.conf << 'NGINX_SSL_CONF'
worker_processes auto;
events {
    worker_connections 1024;
}

rtmp {
    server {
        listen 1935;
        chunk_size 4000;
        
        application live {
            live on;
            record off;
            allow publish 127.0.0.1;
            deny publish all;
            allow play all;
        }
    }
}

http {
    include       mime.types;
    default_type  application/octet-stream;
    
    sendfile off;
    tcp_nopush on;
    directio 512;
    
    # Configuración para archivos grandes
    client_max_body_size 0;
    client_body_timeout 3600;
    client_header_timeout 3600;
    keepalive_timeout 3600;
    send_timeout 3600;
    proxy_connect_timeout 3600;
    proxy_send_timeout 3600;
    proxy_read_timeout 3600;
    
    # Buffer sizes
    client_body_buffer_size 128M;
    client_header_buffer_size 64k;
    large_client_header_buffers 4 64k;
    
    # Gzip
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    # Redirección HTTP a HTTPS
    server {
        listen 80;
        server_name streamhub.sofe.site;
        return 301 https://$server_name$request_uri;
    }

    # Servidor HTTPS con HTTP/2
    server {
        listen 443 ssl http2;
        server_name streamhub.sofe.site;

        ssl_certificate /etc/letsencrypt/live/streamhub.sofe.site/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/streamhub.sofe.site/privkey.pem;
        
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers HIGH:!aNULL:!MD5;
        ssl_prefer_server_ciphers on;
        ssl_session_cache shared:SSL:10m;
        ssl_session_timeout 10m;

        # Seguridad
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-XSS-Protection "1; mode=block" always;
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

        location / {
            proxy_pass http://localhost:3000;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_cache_bypass $http_upgrade;
            
            # Timeouts largos
            proxy_connect_timeout 3600;
            proxy_send_timeout 3600;
            proxy_read_timeout 3600;
            
            # Buffer sizes
            proxy_buffer_size 128k;
            proxy_buffers 4 256k;
            proxy_busy_buffers_size 256k;
        }

        # WebSocket
        location /ws {
            proxy_pass http://localhost:3000;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }
    }
}
NGINX_SSL_CONF

# 5. Verificar configuración
print_info "Verificando configuración NGINX..."
/usr/local/nginx/sbin/nginx -t

if [ $? -eq 0 ]; then
    print_status "Configuración NGINX válida"
else
    print_error "Error en configuración NGINX"
    exit 1
fi

# 6. Iniciar NGINX
print_info "Iniciando NGINX con SSL..."
systemctl start nginx-rtmp
systemctl enable nginx-rtmp

# 7. Configurar renovación automática
print_info "Configurando renovación automática..."
cat > /etc/systemd/system/certbot-renewal.service << 'EOF'
[Unit]
Description=Certbot Renewal
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/bin/certbot renew --quiet --deploy-hook "systemctl reload nginx-rtmp"
EOF

cat > /etc/systemd/system/certbot-renewal.timer << 'EOF'
[Unit]
Description=Run certbot twice daily

[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable certbot-renewal.timer
systemctl start certbot-renewal.timer

print_status "¡SSL configurado correctamente!"
print_info "Sitio disponible en: https://streamhub.sofe.site"

# Verificar estado
if systemctl is-active --quiet nginx-rtmp; then
    print_status "NGINX funcionando correctamente"
else
    print_error "NGINX no está activo"
    systemctl status nginx-rtmp
fi
