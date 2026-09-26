# Pulso TransMi -- Panel (bono Vercel)

Dashboard de solo lectura del pipeline MLOps del equipo. Sin build step: HTML +
CSS + JS plano, sin dependencias.

## Seguridad

Solo usa la clave publica (`anon`/`publishable`) de Supabase, expuesta a
proposito en `config.js` -- es segura para el navegador porque RLS bloquea el
acceso directo a las tablas crudas. El panel solo puede leer estas vistas:

- `v_pipeline_status`
- `v_model_state`
- `v_accuracy_timeseries`
- `v_station_accuracy`
- `v_leaderboard_snapshots`

Ninguna API key de submissions ni credencial administrativa de Supabase vive
en este repo ni llega al navegador.

## Que muestra

1. Estado del ultimo ciclo del pipeline (verde/rojo)
2. Accuracy acumulada y ultimas 24h, con linea de baseline
3. Anotaciones de reentrenamiento y drift sobre la curva
4. Cobertura de ciclos entregados
5. Accuracy por estacion
6. Mapa de calor de drift (estacion x horizonte)
7. Historial de corridas del pipeline
8. Modelo champion activo
9. Posicion en el leaderboard del curso (via `leaderboard_snapshots`, que
   llena `monitor.py` server-side -- la API key de submissions nunca sale
   del pipeline)
