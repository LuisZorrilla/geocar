# Monedas y tipos de cambio

El sistema trabaja con **pesos argentinos (ARS), bolívares venezolanos (VES), dólares estadounidenses (USD) y pesos chilenos (CLP)**. Solo el **superadmin** de la plataforma administra las monedas, carga los tipos de cambio y decide la moneda de cada empresa.

## Reglas

- **Cada empresa tiene una moneda.** Todos sus importes se guardan en esa moneda: órdenes de trabajo (repuestos y mano de obra), inventario, mantenimientos y planes preventivos.
- **Pivote USD.** Cada cotización se carga como «cuántas unidades de la moneda equivalen a 1 USD», y el dólar vale siempre 1. Los cruces se calculan con `A→B = tasaB / tasaA`, así que la correlación entre monedas es consistente por construcción: ARS→CLP siempre da lo mismo que ARS→USD→CLP.
- **Cotizaciones con fecha.** Cada cotización tiene fecha de vigencia y no se borra. Para convertir un documento se usa la cotización vigente en su fecha.
- **Moneda de referencia.** Cada empresa elige una moneda de referencia (USD por defecto). Los totales e indicadores muestran al lado un equivalente chico (`≈ US$ …`), calculado con el tipo de cambio de la fecha del documento.

## Pantalla «Monedas» (solo superadmin)

- **Monedas:** se edita el nombre, el símbolo, los decimales (CLP usa 0) y la fuente sugerida, y cada moneda se puede habilitar o deshabilitar. El USD no se puede deshabilitar, y tampoco una moneda que use alguna empresa.
- **Cargar cotización:** «1 USD equivale a …» con su fecha de vigencia y una nota opcional. Si el valor cambia más de un 10 % respecto del vigente, la pantalla avisa.
- **Traer cotización sugerida:** el servidor consulta fuentes públicas, sin claves y con un límite de 5 s, y **no guarda nada**: el superadmin elige la cotización y confirma con «Guardar cotización».

  | Moneda | Fuentes |
  |---|---|
  | ARS | dolarapi.com: oficial BNA, MEP, blue y mayorista (precio de venta) |
  | VES | ve.dolarapi.com: oficial BCV y paralelo (promedio) |
  | CLP | mindicador.cl (dólar observado del Banco Central) o cl.dolarapi.com |

  Si una fuente no responde, se muestra el error y la cotización se carga a mano. Cada fuente tiene su propio adaptador en `server/currency/sources.ts`.
- **Cruces vigentes:** una matriz con el valor de cada moneda en todas las demás.
- **Historial:** todas las cotizaciones de cada moneda, con quién las cargó.
- **Cotización desactualizada:** se avisa cuando la vigente tiene más de 1 día en VES o más de 7 días en las demás monedas.
- **Consolidado de todas las empresas:** moneda en la que el superadmin ve los totales de la vista «Todas las empresas» (USD por defecto).

## Moneda de cada empresa (Empresas)

- **Alta:** el asistente pide la moneda y la moneda de referencia.
- **Empresas anteriores a esta función:** quedan **«Sin moneda»** (aviso ámbar). Al definirla por primera vez, los importes se conservan tal cual, porque se cargaron en esa moneda.
- **Cambiar la moneda:** se toca la moneda en la lista. El diálogo muestra una vista previa con la tasa, la cantidad de documentos y el total antes y después, y ofrece dos opciones:
  - **Convertir importes:** convierte todos los importes de la empresa con la cotización vigente, en una sola operación.
  - **Solo cambiar el rótulo:** los números no cambian. Sirve solo para corregir una moneda mal elegida.

  Cada cambio queda en el historial (`currency_changes`) y en la auditoría. Ninguna de las dos opciones se deshace sola: para volver atrás, se convierte de nuevo con la tasa inversa.

## Carga en otra moneda

Al lado del importe de un repuesto, de la mano de obra o del costo de un artículo de almacén hay un selector de moneda.

- Si se elige una moneda distinta de la de la empresa, el servidor convierte el importe con la cotización de la fecha de la orden, o con la vigente en el caso del almacén.
- También guarda el importe original y la tasa usada, que se ven en la orden.
- Editar la orden no cambia la conversión: se vuelve a usar la fecha de la orden.
- Si falta la cotización, el servidor rechaza la carga con un mensaje claro y no inventa ningún valor.

## Consolidado (superadmin, «Todas las empresas»)

- **Tablero de mantenimiento y totales:** se convierten a la moneda del consolidado con la cotización de la fecha de cada orden. Las órdenes de empresas sin moneda, o sin cotización para esa fecha, quedan fuera de la suma y se avisa cuántas son.
- **Exportaciones:** Excel usa el formato de cada moneda (`"US$" #,##0.00`, `"CLP$" #,##0`), y PDF y CSV usan su símbolo.
  - El CSV de órdenes agrega la columna **Moneda** al final.
  - El informe consolidado agrega «Moneda de la empresa» y «Total en su moneda».

## Datos técnicos

- **Migración `005_currencies.sql`:** crea las tablas `currencies`, `exchange_rates` y `currency_changes`, y agrega a `tenants` las columnas `currency` (vacía hasta definirla) y `reference_currency`.
- **Nombres de campos:** los importes ya no terminan en `Mxn` (`totalCost`, `unitCost`, `laborCost`, `estimatedCost`, `cost`…). Al cargar el estado, los datos guardados con los nombres viejos se renombran solos.
- **API:**

  | Método y ruta | Quién | Para qué |
  |---|---|---|
  | `GET /api/currencies` | cualquier usuario autenticado | listar monedas y cotizaciones |
  | `PATCH /api/currencies/:code` | superadmin | editar una moneda |
  | `POST /api/currencies/:code/rates` | superadmin | cargar una cotización |
  | `GET /api/currencies/rates/history` | superadmin | historial de cotizaciones |
  | `GET /api/currencies/rates/suggest` | superadmin | cotización sugerida |
  | `PUT /api/settings/platform-currency` | superadmin | moneda del consolidado |
  | `GET /api/tenants/:id/currency/preview` | superadmin | vista previa de la conversión |
  | `PUT /api/tenants/:id/currency` | superadmin | definir o cambiar la moneda de una empresa |

- **Pruebas:** `tests/currency.test.ts`.
