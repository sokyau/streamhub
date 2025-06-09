#!/bin/bash

# StreamHub Start Script v2.0
# With health checks and service verification

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_status() { echo -e "${GREEN}[✓]${NC} $1"; }
print_error() { echo -e "${RED}[✗]${NC} $1"; }
print_info() { echo -e "${YELLOW}[i]${NC} $1"; }

# Change to StreamHub directory
cd ~/streamhub

# Check NGINX
print_info "Verificando NGINX..."
if /usr/local/nginx/sbin/nginx -t 2>/dev/null; then
    print_status "Configuración de NGINX válida"
else
    print_error "Error en configuración de NGINX"
    exit 1
fi

# Check if NGINX is compiled with HTTP/2
if /usr/local/nginx/sbin/nginx -V 2>&1 | grep -q "http_v2_module"; then
    print_status "NGINX tiene soporte HTTP/2"
else
    print_error "NGINX no tiene soporte HTTP/2 - ejecuta setup-ssl-nginx-fixed.sh"
    exit 1
fi

# Start/Restart NGINX
print_info "Iniciando NGINX..."
if systemctl is-active --quiet nginx-rtmp; then
    systemctl reload nginx-rtmp
    print_status "NGINX recargado"
else
    systemctl start nginx-rtmp
    print_status "NGINX iniciado"
fi

# Create necessary directories
print_info "Creando directorios necesarios..."
mkdir -p uploads temp db logs
print_status "Directorios creados"

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    print_error "Node.js 18 o superior requerido. Versión actual: $(node -v)"
    exit 1
fi
print_status "Node.js $(node -v) detectado"

# Install dependencies if needed
if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules" ]; then
    print_info "Instalando dependencias..."
    npm install
    print_status "Dependencias instaladas"
fi

# Run database migrations
if [ -f "db-migrate.js" ]; then
    print_info "Ejecutando migraciones de base de datos..."
    node db-migrate.js || true
fi

# Check if database exists
if [ ! -f "db/streamhub.db" ]; then
    print_info "Creando base de datos..."
    sqlite3 db/streamhub.db < db-migration.sql
    print_status "Base de datos creada"
fi

# Start application with PM2
print_info "Iniciando StreamHub con PM2..."
pm2 delete streamhub 2>/dev/null || true
pm2 start ecosystem.config.js --env production
pm2 save
print_status "StreamHub iniciado con PM2"

# Health check
print_info "Verificando servicios..."
sleep 3

# Check if application is running
if pm2 list | grep -q "streamhub.*online"; then
    print_status "Aplicación ejecutándose correctamente"
else
    print_error "Error al iniciar la aplicación"
    pm2 logs streamhub --lines 20
    exit 1
fi

# Check if port 3000 is listening
if netstat -tlnp 2>/dev/null | grep -q ":3000"; then
    print_status "Puerto 3000 activo"
else
    print_error "Puerto 3000 no está escuchando"
fi

# Check NGINX upstream
if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 | grep -q "200\|302"; then
    print_status "Backend respondiendo correctamente"
else
    print_error "Backend no responde"
fi

# Get server IP
SERVER_IP=$(hostname -I | awk '{print $1}')

echo ""
echo "========================================"
echo -e "${GREEN}StreamHub iniciado correctamente${NC}"
echo "========================================"
echo ""
echo "Accede a tu aplicación en:"
echo -e "  ${GREEN}HTTP:${NC}  http://${SERVER_IP}"
echo -e "  ${GREEN}HTTPS:${NC} https://streamhub.sofe.site"
echo ""
echo "Comandos útiles:"
echo "  pm2 logs streamhub    # Ver logs"
echo "  pm2 restart streamhub # Reiniciar"
echo "  pm2 stop streamhub    # Detener"
echo "  pm2 monit            # Monitor en tiempo real"
echo ""
echo "Estado de servicios:"
pm2 status
echo ""
