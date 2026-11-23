# Ruteo: OSRM y VROOM (opcional)

El panel planifica y estima tiempos **sin instalar nada**: usa distancias estimadas, en línea recta × 1,25, a una velocidad promedio. Si en el VPS se levantan **OSRM** (rutas por calle) y **VROOM** (optimización con varias unidades), el panel los usa solo. El indicador de Operaciones pasa a decir «Rutas por calle».

Si alguno de los dos no responde (4 s de espera), el panel vuelve al motor propio sin cortar el servicio.

## Variables (`.env` del panel)

| Variable | Ejemplo | Para qué |
|---|---|---|
| `OSRM_URL` | `http://127.0.0.1:5000` | Distancias, tiempos y trazado por calle. |
| `VROOM_URL` | `http://127.0.0.1:3010` | Optimizador para varias unidades del planificador. Recibe la matriz que arma el panel, así que no necesita mapa propio. |
| `ROUTING_AVG_KMH` | `45` | Velocidad promedio del cálculo estimado (cuando no hay OSRM). |

**Uso independiente:** se puede usar uno solo.
- Con solo OSRM: las distancias son reales y el optimizador es el propio.
- Con solo VROOM: optimiza sobre las distancias estimadas.

## Requisitos del VPS

- **Preparación del mapa** (una vez, y en cada actualización): unos **8 GB de RAM** y 10 GB de disco para el extracto de Argentina.
- **En uso:** unos **2 GB de RAM** para OSRM y unos cientos de MB para VROOM.
- **Red:** los puertos 5000 y 3010 **no** se exponen a internet; los usa solo el panel, en `127.0.0.1`.

## Instalación con Docker

```bash
mkdir -p /opt/ruteo/osrm && cd /opt/ruteo/osrm
wget https://download.geofabrik.de/south-america/argentina-latest.osm.pbf

# Preparación (perfil auto). Tarda varios minutos.
docker run --rm -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-extract -p /opt/car.lua /data/argentina-latest.osm.pbf
docker run --rm -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-partition /data/argentina-latest.osrm
docker run --rm -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-customize /data/argentina-latest.osrm
```

`/opt/ruteo/docker-compose.yml`:

```yaml
services:
  osrm:
    image: ghcr.io/project-osrm/osrm-backend
    command: osrm-routed --algorithm mld --max-table-size 1000 /data/argentina-latest.osrm
    volumes: ["./osrm:/data"]
    ports: ["127.0.0.1:5000:5000"]
    restart: unless-stopped
  vroom:
    image: ghcr.io/vroom-project/vroom-docker:v1.14.0
    ports: ["127.0.0.1:3010:3000"]
    environment:
      VROOM_ROUTER: osrm
    restart: unless-stopped
```

```bash
cd /opt/ruteo && docker compose up -d
curl "http://127.0.0.1:5000/route/v1/driving/-68.5364,-31.5375;-68.5360,-31.5770?overview=false"   # debe responder "code":"Ok"
```

Después se cargan `OSRM_URL` y `VROOM_URL` en el `.env` del panel y se reinicia.

## Actualizar el mapa

Una vez por mes alcanza:
1. Volver a descargar el `.pbf`.
2. Repetir los tres pasos de preparación.
3. Correr `docker compose restart osrm`.

## Qué usa cada pantalla

| Pantalla | OSRM | VROOM |
|---|---|---|
| Detalle del viaje (trazado, km y hora estimada por parada) | ✔ | — |
| «Optimizar orden» de un viaje | matriz | — (siempre el optimizador propio: exacto hasta 8 paradas) |
| Planificador del día | matriz | ✔ (si no está, optimizador propio) |
| Hora estimada en vivo y alerta «Demora prevista» (cada minuto) | ✔ | — |
| Seguimiento público (hora estimada de llegada) | vía la hora estimada en vivo | — |
