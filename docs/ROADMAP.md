# Vigilant FleetOps: hoja de ruta de prototipo a producción

**Supuestos:**
- Arranque con menos de 200 unidades.
- Dashcams JT808/JT1078.
- Hosting en la nube.

Con ese tamaño **no** hacen falta Kafka ni microservicios. Basta con un servidor de aplicación, un gateway TCP, un servidor de video, PostgreSQL y S3.

## Arquitectura objetivo

```
Dashcams ──TCP 808x (JT808)──► Gateway JT808 (Node) ──► PostgreSQL
        └─TCP/RTP (JT1078)──► Servidor de video ──► HLS/WebRTC al navegador
                                                └─► S3 (clips de evidencia)
Navegador ◄─HTTPS + WebSocket─► API Express ◄─► PostgreSQL / Redis
```

## Fases

| Fase | Contenido | Estimación | Estado |
|---|---|---|---|
| 0 | **Validar hardware.** 1-2 dashcams del modelo final, manual del protocolo del fabricante (extensiones ADAS/DMS 0x64/0x65, adjuntos 0x1210-0x1212), listener TCP que registre 0x0100/0x0102/0x0200/0x0002/0x0704 y prueba de video JT1078. | 1-2 sem | Pendiente |
| 1 | **Backend real.** PostgreSQL, hash de contraseñas, sesiones persistentes con expiración, aislamiento multiempresa, validación de entradas y auditoría. | 3-4 sem | **En curso (Sprint 1)** |
| 2 | **Gateway JT808.** Parser de tramas (escape 0x7E/0x7D, checksum, subpaquetes), respuestas 0x8001/0x8100, tabla `positions` particionada por fecha, `last_position`, alarmas hacia `Alert`, WebSocket en lugar del polling `/api/telemetry/tick`, comandos 0x8103/0x8201/0x8300. | 3-5 sem | Pendiente |
| 3 | **Video JT1078.** Servidor de medios (ZLMediaKit o similar), comandos 0x9101/0x9102/0x9205/0x9201, reproductor hls.js/mpegts.js, clips en S3 con ciclo de vida según `retentionDays` y URLs firmadas. | 3-4 sem | Pendiente |
| 4 | **Infraestructura.** Docker Compose en VM, Postgres administrado, S3, TLS, puertos TCP con IP fija, CI/CD, respaldos automáticos, Sentry y tiles de mapa con licencia. | 1-2 sem | Pendiente |
| 5 | **Legal y negocio (MX).** Aviso de privacidad (LFPDPPP), consentimiento de conductores por la grabación de cabina, SLA, facturación por `planTier`, costo de SIMs de datos (preferir clips por evento sobre grabación continua). | continuo | Pendiente |
| 6 | **Piloto.** 10-20 unidades durante 2 semanas: latencia, pérdida de posiciones y costo de datos. Luego escalar a 200. | 2 sem | Pendiente |

## Sprint 1 (Fase 1, primera parte)

### Paso A: Seguridad de autenticación
- [x] Contraseñas con hash scrypt (`server/auth/password.ts`) y política mínima: 10 caracteres, con letras y números.
- [x] Se eliminó `GET /api/auth/demo-accounts`. Las credenciales demo solo se imprimen en la consola del servidor al sembrar.
- [x] El token ya no viaja en la URL: las descargas usan el header `Authorization`.
- [x] Sesiones con expiración por inactividad y absoluta. En la base de datos solo se guarda el hash del token.
- [x] Bloqueo tras 5 intentos fallidos, rate limit en `/api/auth/*` y cabeceras de seguridad con `helmet`.
- [x] Endpoint `POST /api/auth/change-password` y reset de contraseña por un admin.

### Paso B: PostgreSQL (híbrido incremental)
- [x] Migraciones SQL versionadas (`server/db/migrations`).
- [x] Tablas normalizadas: `tenants`, `roles`, `users`, `sessions`.
- [x] Tablas documento (`id`, `tenant_id`, `data jsonb`) para el resto de las colecciones.
- [x] `FleetStore` carga el estado desde Postgres al arrancar y escribe con diff en una transacción. Cada respuesta de escritura espera a que el dato quede guardado.
- [x] IDs generados con `crypto.randomUUID()`.

### Pendiente para cerrar la Fase 1
- [ ] Validación de entradas con zod en todos los endpoints.
- [ ] Row-Level Security de Postgres por `tenant_id`.
- [ ] Revisar el alcance por defecto del superadmin (`resolveTargetTenantId` cae en `ten-norte`).
- [ ] Normalizar las tablas documento una por una, empezando por `vehicles` y `devices` porque las necesita el gateway.
- [ ] Recuperación de contraseña por correo y 2FA para administradores.

## Desarrollo local

1. Instalar PostgreSQL 17: `winget install PostgreSQL.PostgreSQL.17` o el instalador oficial.
2. Crear la base: `createdb -U postgres geocar`.
3. Copiar `.env.example` a `.env` y ajustar `DATABASE_URL`.
4. Ejecutar `npm install` y luego `npm run dev`. Con `SEED_DEMO_DATA=true` la primera ejecución siembra los datos demo e imprime las credenciales en la consola.
5. `npm run db:reset` borra todas las tablas y vuelve a sembrar. **Es solo para desarrollo.**
