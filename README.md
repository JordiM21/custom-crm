# LET Junior — Asistente de ventas por WhatsApp

Un servicio que responde los mensajes de WhatsApp de los papás en español, los
califica, agenda clases de prueba, manda links de pago, y te pasa la
conversación a ti en el momento en que hace falta una persona.

Construido según `SPEC.md`, milestones M1 a M5.

> There is an English version of this document in [`README.en.md`](README.en.md).

---

## Léelo primero: qué existe hoy

| Parte | Estado |
|---|---|
| Modo prueba: hablar con el bot sin WhatsApp | Listo — ver la siguiente sección |
| Webhook, verificación de firma, no duplicar mensajes | Listo y probado |
| Captura de contactos y atribución de anuncios (`ctwa_clid`) | Listo y probado |
| El bot se calla cuando respondes desde tu teléfono | Listo y probado |
| El agente: prompt, historial, ritmo de respuesta, tope de 2 mensajes | Listo y probado |
| Las seis herramientas: calendario, agendar, Stripe, escalar, actualizar contacto, seguimiento | Listo y probado |
| Panel de administración | Listo |
| Avisarte por WhatsApp, correo y webhook | Listo y probado |
| Mandar conversiones a Meta (M6) | **Sin construir.** Los eventos se guardan y esperan en la base de datos. |
| Mensajes de plantilla, notas de voz, imágenes | **Sin construir.** Fuera del alcance de la v1. |

128 pruebas automáticas pasan. Lo que **no** está probado es todo lo que toca
una cuenta real, porque todavía no hay cuentas conectadas.

**Ahora mismo el sistema corre en modo demostración:** base de datos falsa,
respuestas falsas, nada se envía a WhatsApp. Es a propósito. Puedes abrir el
panel y usarlo hoy, y cada cosa que conectes cambia una pieza de falsa a real.

---

## Verlo funcionando en dos minutos

```bash
npm install
npm run dev:local
```

Abre <http://localhost:3000>. Vas a ver el panel con ocho contactos inventados
y sus conversaciones. Nada de lo que hagas ahí toca un teléfono real.

---

# Probarlo hoy, sin WhatsApp

Conectar WhatsApp lleva días de papeleo con Meta. No tienes que esperar a eso
para saber si el bot suena bien. Este camino toma media hora y necesita una
sola cuenta: Anthropic.

## 1. Consigue una clave de Anthropic (5 min)

1. Entra a [console.anthropic.com](https://console.anthropic.com).
2. **Settings → Billing** → agrega una tarjeta y algo de saldo. Con USD 5
   tienes para muchísimo tiempo a este volumen (ver el costo más abajo).
3. **API keys → Create key**. Cópiala. Empieza con `sk-ant-`. Solo la ves una
   vez.

## 2. Córrelo en tu computadora (10 min)

```bash
git clone https://github.com/JordiM21/custom-crm.git
cd custom-crm
npm install
cp .env.example .env.local
```

Abre `.env.local` y pon solo estas tres líneas:

```
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...tu-clave...
ANTHROPIC_MODEL=claude-haiku-4-5
```

Deja todo lo demás vacío. Después:

```bash
npm run dev:local
```

Abre <http://localhost:3000>. No hace falta contraseña mientras
`ADMIN_PASSWORD` esté vacío, y no hace falta base de datos: corre con datos de
ejemplo.

## 3. Habla con él (20 min, y es la parte que importa)

Entra a la pestaña **Probar**. Escribe como si fueras un papá. El bot responde
con el modelo real, usando el prompt real y la información real del negocio.
Desde esa pantalla nunca sale nada a WhatsApp, ni siquiera en producción.

Vale la pena probar esto, porque cada mensaje ejercita una regla distinta:

| Escribe esto | Qué debería pasar |
|---|---|
| `hola` | Un saludo corto y **una** sola pregunta. Nunca un precio. |
| `cuanto cuesta?` | Debería preguntar la edad del niño antes de dar precios. |
| `tiene 9 años, se llama Sofía` | Debería guardar nombre y edad — míralo en la línea debajo del chat. |
| `tienen descuento por dos hermanos?` | **Debería responder que sí**, el segundo paga mitad. Está en la información. |
| `me puedes hacer un precio mejor?` | Directo a ti. La etapa pasa a "Atendido por Jordi". |
| `quiero que me devuelvan el dinero` | Igual — los reembolsos nunca llegan al modelo. |
| `mi hijo tiene dislexia, sirve?` | Igual — cualquier tema del niño es tuyo. |
| `esto es un bot?` | Debería decir que es un asistente y que tú lees todo. |

**"Empezar de nuevo"** borra la conversación para que pruebes otra apertura.

## 4. Hacer que suene como tú

Este es el ciclo que de verdad mejora el bot, y es todo lo que la gente quiere
decir cuando habla de "entrenarlo":

1. Lee una respuesta en **Probar** que no te guste.
2. Decide qué tipo de problema es:
   - **Dato equivocado** (precio, horario, política) → arregla
     `knowledge/business.md`.
   - **Tono o comportamiento equivocado** (muy formal, dos preguntas juntas,
     vende demasiado pronto) → dímelo y cambio las reglas del prompt.
3. Reinicia (`Ctrl+C` y otra vez `npm run dev:local`) y prueba el mismo
   mensaje.

Casi todo lo que vas a querer cambiar está en el archivo de información, no en
el prompt.

## Qué NO prueba esto

- Nada de Meta: recibir mensajes reales, el traspaso cuando respondes desde tu
  teléfono, la ventana de 24 horas. Eso necesita el paso 4 de la instalación.
- Google Calendar y Stripe, salvo que los conectes.
- El ritmo de respuesta. El modo prueba responde al instante a propósito; en un
  número real las respuestas esperan entre 8 y 45 segundos.

## Cuánto cuesta

Claude Haiku 4.5 cuesta USD 1 por millón de tokens de entrada y USD 5 por
millón de salida. Una conversación completa con un papá está en el orden de un
centavo de dólar. Una tarde entera de pruebas no llega a un dólar.

El costo exacto de cada conversación aparece debajo del chat y en la ficha del
contacto, y `AI_COST_CEILING_USD` te pasa cualquier conversación que se pase de
ese monto, así que un bucle no te puede generar una factura.

---

# Ponerlo en vivo, en orden

Haz esto en orden. Cada paso dice qué se rompe si te lo saltas. La página
**Conexiones** del panel muestra la misma lista, en vivo, para que siempre
sepas dónde estás sin volver a leer este archivo.

**Nunca me mandes una contraseña, clave o token por chat.** Todos los secretos
van directo a Vercel. Cuando termines un paso, dime "paso 3 listo".

---

## Paso 0 — El bloqueo: ¿tu número se puede usar?

**Haz esto antes que nada.** Todo lo demás depende de esto.

Tu número de WhatsApp puede estar atado todavía a otro proveedor (Kommo, o lo
que hayas usado antes). Un número solo puede estar conectado a una plataforma a
la vez. Si está atado a otro lado, hay que liberarlo antes de que la Cloud API
de Meta lo pueda usar.

Qué revisar, en [business.facebook.com](https://business.facebook.com) →
Cuentas de WhatsApp:

1. ¿Aparece tu número ahí?
2. ¿Está conectado a otro proveedor (un "BSP")?
3. ¿Meta te ofrece la opción de **coexistencia** para ese número? La
   coexistencia es lo que te deja seguir usando la app de WhatsApp Business en
   tu teléfono *y* que este servicio conteste al mismo tiempo. Es el diseño
   completo de este sistema.

**Dime qué encuentras.** Si el número está bloqueado con otro proveedor, eso es
lo primero que hay que resolver y ningún otro paso importa hasta que esté hecho.

Una regla para recordar siempre: con coexistencia, **tienes que abrir la app de
WhatsApp Business en tu teléfono al menos una vez cada 13 días** o la conexión
se desactiva.

---

## Paso 1 — Ponerlo en línea (Vercel)

1. Entra a [vercel.com](https://vercel.com) con tu cuenta de GitHub.
2. **Add New → Project**, elige `JordiM21/custom-crm`.
3. Framework preset: **Other**. No cambies nada más.
4. Deploy.

Te queda una dirección tipo `https://custom-crm-xxxx.vercel.app`. El panel está
ahí. Todavía corre con datos de ejemplo.

Después pon las dos primeras variables, en **Settings → Environment
Variables**:

| Variable | Valor |
|---|---|
| `ADMIN_PASSWORD` | Una contraseña larga que inventes. Es la que abre el panel. |
| `SESSION_SECRET` | Cualquier texto largo y aleatorio. |

Cada vez que agregues variables tienes que ir a **Deployments → ⋯ → Redeploy**
para que tomen efecto. Esto aplica a todos los pasos de abajo.

**Si te lo saltas:** cualquiera que encuentre la dirección puede abrir el panel.

**Mándame:** la dirección de Vercel.

---

## Paso 2 — La base de datos (Supabase)

Sin esto, cada contacto y cada conversación desaparecen en cada despliegue.

1. [supabase.com](https://supabase.com) → nuevo proyecto. El plan gratis
   alcanza. Elige una región cercana a Latinoamérica (`us-east-1` sirve).
2. Espera a que termine de crearse.
3. Menú izquierdo → **SQL Editor** → **New query**.
4. Abre `db/schema.sql` de este repositorio, copia todo, pégalo y dale **Run**.
   Debería decir que salió bien. Se puede correr dos veces sin problema.
5. Menú izquierdo → **Project Settings → API**. Copia dos cosas:

| Variable | Dónde está en Supabase |
|---|---|
| `SUPABASE_URL` | Project Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → clave `service_role` (**secreta**, nunca la pongas en un navegador ni en un mensaje) |

6. Pon las dos en Vercel y vuelve a desplegar.

El panel deja de decir "datos de ejemplo" y queda vacío. Eso está bien: ahora
muestra tus datos reales, y todavía no tienes ninguno.

**Si te lo saltas:** no se guarda nada.

---

## Paso 3 — El proveedor de IA

Estamos usando **Claude Haiku 4.5** de Anthropic.

```
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5
```

**No hay ningún paso de entrenamiento ni de fine-tuning.** Lo que el bot sabe
sale de `knowledge/business.md`; cómo se comporta sale de las reglas del prompt
en `lib/agent/prompt.ts`. Cambiar un dato es editar un archivo de texto.

Control de costo:

```
AI_COST_CEILING_USD=1.00     # si una conversación pasa de esto, te la paso a ti
AI_PRICE_IN_PER_MTOK=1       # tarifas de Haiku 4.5, solo para estimar el gasto
AI_PRICE_OUT_PER_MTOK=5
```

### Si algún día quieres cambiar de proveedor

Todo el código habla con la IA a través de una sola interfaz. Cambiar de
proveedor es cambiar variables de entorno, sin tocar código:

```
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://api.openai.com/v1     # o la dirección del proveedor
AI_API_KEY=...
AI_MODEL=...
```

Esto cubre OpenAI, Groq, Together, OpenRouter, Mistral, DeepSeek y casi
cualquier servidor propio.

**Si te lo saltas:** el bot responde con frases fijas de demostración, no con
respuestas reales.

---

## Paso 4 — WhatsApp (Meta)

Es el paso más largo. Haz el Paso 0 primero.

### 4a. Crear la app

1. [developers.facebook.com](https://developers.facebook.com) → **My Apps** →
   **Create App** → tipo **Business**.
2. Dentro de la app, agrega el producto **WhatsApp**.
3. Conecta tu portafolio de negocio y tu número.

### 4b. Juntar cuatro datos

| Variable | Dónde |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → API Setup → "Phone number ID" (un número, **no** tu teléfono) |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | La misma página, "WhatsApp Business Account ID" |
| `META_ACCESS_TOKEN` | Business Settings → Users → **System Users** → crea uno con acceso admin → Generate token → elige tu app → permisos `whatsapp_business_messaging` y `whatsapp_business_management`. Elige **que nunca expire**. Un token temporal funciona un día y después se rompe sin avisar. |
| `META_APP_SECRET` | App Settings → Basic → App Secret → Show |

Más uno que inventas tú:

| Variable | Valor |
|---|---|
| `META_WEBHOOK_VERIFY_TOKEN` | Cualquier texto aleatorio. Lo escribes en Meta en el siguiente paso, y Meta te lo devuelve para probar que es él. |

Pon los cinco en Vercel y vuelve a desplegar.

### 4c. Apuntar Meta al webhook

1. En la app → WhatsApp → **Configuration** → Webhooks → Edit.
2. Callback URL: `https://TU-DIRECCION-DE-VERCEL/api/webhook`
3. Verify token: el `META_WEBHOOK_VERIFY_TOKEN` que inventaste.
4. Dale **Verify and save**. Tiene que ponerse en verde. Si no, el token no
   coincide o no volviste a desplegar.
5. Suscríbete a estos campos:
   - `messages` — obligatorio
   - `message_echoes` **y/o** `smb_message_echoes` — suscríbete a los que te
     aparezcan. Así es como el bot se entera de que respondiste desde tu
     teléfono. Sin esto, el bot te va a hablar encima.
   - `account_update` — te avisa si WhatsApp desconecta el número

### 4d. Revisar la versión del Graph API

`META_GRAPH_VERSION` está en `v23.0` por defecto. Revisa el
[changelog de Meta](https://developers.facebook.com/docs/graph-api/changelog)
y pon la versión actual. No confíes en el número escrito acá: envejece.

**Si te saltas este paso:** el bot no puede recibir ni enviar nada.

---

## Paso 5 — Cómo te avisamos (importante)

Cuando un papá necesita que respondas tú, tienes que enterarte **en el
momento**, no cuando abras el panel.

Hay tres canales y puedes usar los tres a la vez. **Configura al menos dos.**

### 5a. WhatsApp

| Variable | Valor |
|---|---|
| `OWNER_WHATSAPP_NUMBER` | Tu número personal, formato internacional, sin `+` y sin espacios. Ejemplo: `573001112233`. |

**Ojo con esto:** Meta aplica la misma regla de 24 horas a tu propio número. Si
tú no le escribiste al número del negocio en el último día, WhatsApp rechaza el
aviso. Por eso WhatsApp solo no alcanza.

### 5b. Correo

Usamos [resend.com](https://resend.com): cuenta gratis, no hace falta
configurar un dominio para empezar.

1. Crea la cuenta.
2. **API Keys → Create API Key**. Cópiala.
3. Pon tu correo en `NOTIFY_EMAIL_TO`.

| Variable | Valor |
|---|---|
| `RESEND_API_KEY` | La clave de Resend |
| `NOTIFY_EMAIL_TO` | Tu correo |
| `NOTIFY_EMAIL_FROM` | Déjalo como está hasta que verifiques tu dominio en Resend |

### 5c. Notificación al teléfono (lo más inmediato)

`NOTIFY_WEBHOOK_URL` es una dirección cualquiera a la que mandamos el aviso.
Sirve con Telegram, Slack, Discord, Zapier, Make, o cualquier servicio de
notificaciones.

La forma más rápida, gratis y sin cuenta:

1. Instala la app **ntfy** en tu teléfono (Android o iPhone).
2. Crea un tema con un nombre difícil de adivinar, por ejemplo
   `let-junior-avisos-x7k2`.
3. Pon `https://ntfy.sh/let-junior-avisos-x7k2` en `NOTIFY_WEBHOOK_URL`.

Listo: cada escalamiento te llega como notificación al teléfono al instante,
sin depender de WhatsApp.

### 5d. Comprobar que funciona

En el panel, **Conexiones → Avisos → "Mandarme un aviso de prueba"**. Te llega
por todos los canales configurados. Hazlo antes de salir en vivo: es lo único
que no se puede saber mirando una pantalla de configuración.

También conviene poner `PUBLIC_URL` con la dirección de tu panel, para que cada
aviso traiga el link directo al contacto.

**Si te saltas este paso:** el bot va a pausar conversaciones esperando que
respondas tú, y no te vas a enterar hasta que abras el panel.

---

## Paso 6 — Google Calendar (agendar clases de prueba)

1. [console.cloud.google.com](https://console.cloud.google.com) → nuevo
   proyecto.
2. **APIs & Services → Library** → activa **Google Calendar API**.
3. **Credentials → Create credentials → Service account**. Créala, ábrela →
   **Keys → Add key → JSON**. Se descarga un archivo.
4. Abre [calendar.google.com](https://calendar.google.com) → tu calendario →
   Configuración → **Compartir con personas específicas** → agrega el correo de
   la cuenta de servicio (se ve como
   `algo@proyecto.iam.gserviceaccount.com`) con permiso de **"Hacer cambios en
   los eventos"**. Sin esto la cuenta de servicio no ve nada.
5. Convierte el archivo JSON a una sola línea:
   ```bash
   base64 -w0 tu-service-account.json     # Linux
   base64 -i tu-service-account.json      # Mac
   ```

| Variable | Valor |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | El resultado del base64 |
| `GOOGLE_CALENDAR_ID` | Configuración del calendario → "Integrar calendario" → ID del calendario. Normalmente tu correo. |
| `BOOKING_TIMEZONE` | Por ejemplo `America/Bogota` |
| `BOOKING_HOURS_START` | Primera hora a la que das clase, reloj de 24h. Ejemplo: `14` |
| `BOOKING_HOURS_END` | Última hora. Ejemplo: `20` |

El bot nunca ofrece un horario a menos de 12 horas de distancia, y vuelve a
revisar el calendario justo antes de agendar, porque dos papás pueden aceptar
el mismo horario con segundos de diferencia.

**Si te lo saltas:** el bot no puede proponer horarios. Esos papás te los pasa
a ti.

---

## Paso 7 — Stripe (links de pago)

1. [dashboard.stripe.com](https://dashboard.stripe.com) → **Developers → API
   keys** → Secret key. Usa primero una clave de **prueba** (`sk_test_`).
2. **Products** → crea un producto por plan:
   - **Plan Inicial** — USD 15, marca el precio como **One time**.
   - **Plan Completo** — USD 50, marca el precio como **Recurring / Monthly**.
3. Copia el ID de cada precio (empieza con `price_`) y pégalo en
   `config/plans.json`. Haz commit.

| Variable | Valor |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` al principio, `sk_live_...` cuando estés listo |

El bot solo puede mandar el link de un plan que exista en ese archivo. Es
incapaz de inventar un precio: si intenta un plan que no existe, la herramienta
devuelve error y la conversación te llega a ti.

El descuento por hermanos (el segundo paga la mitad) no está en Stripe: ese
cobro lo haces tú, porque son dos estudiantes en un mismo pago.

**Si te lo saltas:** el bot no puede mandar links de pago. Esos papás te los
pasa a ti.

---

## Paso 8 — Salir en vivo

Hasta acá `ENVIRONMENT=development` significa que **nunca se manda nada a un
teléfono real**; cada mensaje se escribe en el registro. Prueba todo así
primero.

Prueba con un número de prueba de Meta, nunca con tu número de producción,
hasta que hayas visto una conversación completa funcionar de principio a fin.

Cuando estés listo:

```
ENVIRONMENT=production
BOT_ENABLED=true
CRON_SECRET=<cualquier texto largo y aleatorio>
```

Vuelve a desplegar. El bot está en vivo.

**El interruptor de emergencia:** el switch de arriba a la derecha del panel
apaga el bot al instante, sin redesplegar. Los mensajes se siguen guardando; no
se envía nada. Es lo primero que tienes que tocar si algo sale mal.
`BOT_ENABLED=false` en Vercel es la versión fuerte: fuerza el apagado y el
panel no lo puede encender.

---

# Qué necesito de ti

En orden de lo que más desbloquea:

0. **Pruébalo primero.** Corre la sección de arriba y dime qué suena mal. Te
   cuesta lo que un café en créditos de API y nos dice más que cualquier
   cantidad de planificación.
1. **La respuesta del Paso 0.** ¿Tu número se puede pasar a coexistencia, o
   está bloqueado con otro proveedor? Nada más importa hasta saber eso.
2. **Tres datos que faltan** en `knowledge/business.md` (búscalos con Ctrl+F,
   están entre «comillas angulares»):
   - Con cuántas horas de anticipación hay que avisar para reponer una clase
     del Plan Completo.
   - Qué día se hacen las reposiciones.
   - Cuántos días de garantía tiene el Plan Completo.
3. **La dirección de Vercel,** cuando hagas el Paso 1.
4. **Cualquier cosa que falle.** Una captura de la página Conexiones del panel
   me dice casi todo.

Los secretos van en Vercel, nunca en un mensaje.

---

# Cómo funciona, en corto

Un papá escribe → Meta llama a `/api/webhook` → verificamos la firma, guardamos
el mensaje, y **le contestamos a Meta en menos de un segundo**, porque Meta
reintenta cualquier cosa más lenta y un reintento significa que el papá recibe
la misma respuesta dos veces.

Después, por detrás: si es su primer mensaje desde un anuncio, se guarda el
identificador del clic (aparece una sola vez y nunca más: es lo que le permite
a Meta decirte qué anuncio produjo un estudiante que paga). La conversación
hasta ese momento se manda al proveedor de IA junto con tu archivo de
información. La respuesta entra a una cola con una espera de entre 8 y 45
segundos, porque una respuesta instantánea y perfecta es la señal más clara de
que un papá está hablando con software.

Antes de mandar cada mensaje en cola, el sistema vuelve a revisar: ¿respondió
Jordi desde su teléfono mientras tanto? ¿se cerró la ventana de 24 horas? ¿está
apagado el interruptor? ¿este papá ya recibió 10 mensajes del bot hoy? Si algo
de eso pasa, el mensaje se descarta en vez de enviarse.

**Cuando respondes desde tu teléfono, el bot se calla para ese papá.** Meta nos
reenvía tu mensaje y esa es la señal. No hay ningún comando que recordar. Lo
reactivas desde el panel cuando quieras que el bot retome.

Algunas cosas nunca llegan al modelo. Un papá que negocia el precio, que pide
un reembolso, o que menciona una dificultad de aprendizaje del niño te llega
directo a ti — eso es una revisión de palabras clave en el código, no una
sugerencia en el prompt, porque son justo las conversaciones donde equivocarse
cuesta un cliente o lastima a un niño.

El descuento por hermanos es la excepción: como está escrito en tu archivo de
información, el bot sí lo responde. Cualquier petición más allá de eso te llega
a ti.

---

# Día a día

- **El panel es tu tablero.** Los contactos en rojo ("Te toca a ti") te
  necesitan.
- **Responde desde tu teléfono como siempre.** El bot se hace a un lado solo.
- **Cambiar un precio:** edita `knowledge/business.md`, haz commit, vuelve a
  desplegar.
- **Algo se siente raro:** apaga el switch. Diagnostica después.
- **Cada 13 días:** abre la app de WhatsApp Business en tu teléfono, o la
  conexión de coexistencia se desactiva.

---

# Cuando algo se rompe

| Qué ves | Qué significa |
|---|---|
| El panel dice "datos de ejemplo" | Supabase no está conectado. Paso 2. |
| El webhook de Meta no verifica | `META_WEBHOOK_VERIFY_TOKEN` no coincide, o no volviste a desplegar después de ponerlo. |
| Llegan mensajes pero nadie responde | El bot está apagado, o no hay proveedor de IA, o el contacto está en pausa. El panel dice cuál. |
| El bot responde *encima* de ti | No estás suscrito a los campos de echo. Paso 4c. |
| "Pasaron más de 24 horas" | WhatsApp solo permite mensajes libres dentro de las 24 horas siguientes al mensaje del papá. Tienes que escribir tú primero. |
| Un contacto se pausó solo | O respondiste desde tu teléfono, o llegó al tope de 10 mensajes por día, o escaló. El panel lo dice en palabras. |
| El bot se quedó mudo del todo | Busca un aviso de `ACCOUNT_OFFBOARDED` — cambiar de teléfono o reinstalar la app de WhatsApp Business desconecta la API. |
| No te llegan los avisos | Panel → Conexiones → Avisos → "Mandarme un aviso de prueba". Te dice por cuál canal salió y cuál falló. |

---

# Para un desarrollador

```bash
npm install
npm test          # 128 pruebas, sin red y sin cuentas
npm run typecheck
npm run dev:local # panel + API en localhost:3000, sin Vercel
```

Estructura:

```
api/          puntos de entrada HTTP (webhook, cron, admin)
lib/ai/       interfaz de proveedor + adaptadores anthropic, openai-compatible, mock
lib/agent/    prompt, historial, ritmo, herramientas, escalamiento
lib/store/    interfaz Store + drivers supabase y en memoria
lib/meta/     tipos del webhook, verificación de firma
lib/notify.ts avisos a Jordi por WhatsApp, correo y webhook
public/       el panel
knowledge/    business.md — el único archivo que edita Jordi
config/       plans.json
db/schema.sql
fixtures/     un payload por cada tipo de evento del webhook
tests/
```

Dos desviaciones deliberadas de `SPEC.md`, ambas documentadas donde ocurren:

- **Una quinta tabla, `app_settings`**, para que el interruptor del panel
  funcione sin redesplegar. La spec pone el interruptor solo en una variable de
  entorno; un operador no técnico no puede esperar un build durante una
  emergencia. La variable de entorno sigue mandando.
- **El webhook drena su propia cola** en vez de depender solo del cron, porque
  el plan gratis de Vercel corre los cron una vez al día, lo que dejaría cada
  respuesta atascada horas. El cron queda como red de seguridad.

Y una desviación de criterio, que conviene revisar: la spec dice escalar
*cualquier* petición de descuento. El archivo de información documenta el
descuento por hermanos de forma explícita, así que el bot responde esa y escala
todo lo demás. Está en `lib/agent/prompt.ts` y se revierte en una línea.

Falta construir **M6**: mandar los eventos de conversión a la Conversions API
de Meta. Los eventos ya se guardan en `conversion_events` con su identificador
de clic, esperando a ser enviados. Los contactos sin identificador de clic se
omiten a propósito: mandarlos sin atribución ensucia el dataset.
