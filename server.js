
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const twilio = require("twilio");

const app = express();
app.use(cors()); // Permite conexiones desde https://amor-medicina.netlify.app
app.use(express.json()); // Lee los datos JSON enviados por tu página

// =========================================================================
// 1. VARIABLES DE CONFIGURACIÓN DEL SERVIDOR (WHATSAPP)
// =========================================================================
const PUERTO        = process.env.PORT || 3000;
const ZONA_HORARIA  = "America/Mexico_City";
const TWILIO_SID    = process.env.TWILIO_SID || "";
const TWILIO_TOKEN  = process.env.TWILIO_TOKEN || "";
// Número oficial del Sandbox de WhatsApp en Twilio
const NUMERO_ORIGEN = process.env.NUMERO_ORIGEN || "whatsapp:+14155238886";

const ARCHIVO_DB = path.join(__dirname, "alarmas.json");

// Inicializa Twilio solo si ya existen credenciales válidas (SID empieza con "AC")
const clienteWA = (TWILIO_SID.startsWith("AC") && TWILIO_TOKEN)
  ? twilio(TWILIO_SID, TWILIO_TOKEN)
  : null;

// =========================================================================
// 2. FUNCIONES DE ALMACENAMIENTO Y FORMATO DE WHATSAPP
// =========================================================================
function leerAlarmas() {
  try {
    if (!fs.existsSync(ARCHIVO_DB)) {
      fs.writeFileSync(ARCHIVO_DB, "[]", "utf8");
    }
    return JSON.parse(fs.readFileSync(ARCHIVO_DB, "utf8"));
  } catch (error) {
    return [];
  }
}

function guardarAlarmas(lista) {
  fs.writeFileSync(ARCHIVO_DB, JSON.stringify(lista, null, 2), "utf8");
}

// Convierte 10 dígitos (ej. 5512345678) en formato oficial "whatsapp:+525512345678"
function formatearWhatsApp(tel) {
  const limpio = String(tel || "").replace(/[\s\-\(\)]/g, "").replace(/^whatsapp:/i, "");
  if (!limpio) return "";
  let conPais = limpio;
  if (!limpio.startsWith("+")) {
    conPais = limpio.length === 10 ? "+52" + limpio : "+" + limpio;
  }
  return "whatsapp:" + conPais;
}

function fechaLocalStr() {
  const ahora = new Date(new Date().toLocaleString("en-US", { timeZone: ZONA_HORARIA }));
  return ahora.getFullYear() + "-" + (ahora.getMonth() + 1) + "-" + ahora.getDate();
}

// =========================================================================
// 3. RUTAS DE LA API (Conecta tu página web con el servidor)
// =========================================================================

app.get("/", (req, res) => {
  res.send("💖 Servidor Amor Medicina (WhatsApp) activo. Estado API: " + (clienteWA ? "Conectado" : "Esperando llaves"));
});

app.get("/api/alarmas", (req, res) => {
  res.json(leerAlarmas());
});

// Guarda o actualiza una alarma individual
app.post("/api/alarmas", (req, res) => {
  const { id, n, h, o, ok, telefono } = req.body;
  if (!id || !n || !h) {
    return res.status(400).json({ error: "Faltan datos obligatorios (id, nombre u hora)." });
  }

  const telWA = formatearWhatsApp(telefono);
  let alarmas = leerAlarmas();
  alarmas = alarmas.filter((item) => item.id !== id);
  alarmas.push({
    id: id,
    n: n,
    h: h,
    o: o || "Con mucho amor",
    telefono: telWA,
    ok: Boolean(ok),
    fechaUltimaToma: ok ? fechaLocalStr() : ""
  });

  guardarAlarmas(alarmas);
  console.log(`[ALARMA GUARDADA] ${n} (${h}) -> Destino: ${telWA || "Sin número (apagada)"}`);
  res.json({ mensaje: "Alarma sincronizada", telefono: telWA });
});

// Actualiza o elimina el número de WhatsApp en TODAS las alarmas guardadas
app.put("/api/telefono", (req, res) => {
  const { telefono } = req.body;
  const telWA = formatearWhatsApp(telefono);
  let alarmas = leerAlarmas();

  for (let i = 0; i < alarmas.length; i++) {
    alarmas[i].telefono = telWA;
  }

  guardarAlarmas(alarmas);
  console.log(`[TELÉFONO ACTUALIZADO] Nuevo destino: ${telWA || "VACÍO (Notificaciones desactivadas)"}`);
  res.json({ mensaje: "Teléfono actualizado en el servidor", telefono: telWA });
});

// Marca una medicina como tomada hoy (pausa el WhatsApp por hoy)
app.patch("/api/alarmas/:id", (req, res) => {
  const id = Number(req.params.id);
  const { ok } = req.body;
  let alarmas = leerAlarmas();

  for (let i = 0; i < alarmas.length; i++) {
    if (alarmas[i].id === id) {
      alarmas[i].ok = Boolean(ok);
      alarmas[i].fechaUltimaToma = ok ? fechaLocalStr() : "";
      break;
    }
  }

  guardarAlarmas(alarmas);
  res.json({ mensaje: "Estado actualizado" });
});

// Elimina definitivamente una alarma del servidor
app.delete("/api/alarmas/:id", (req, res) => {
  const id = Number(req.params.id);
  let alarmas = leerAlarmas();
  const nuevas = alarmas.filter((item) => item.id !== id);

  guardarAlarmas(nuevas);
  console.log(`[ALARMA ELIMINADA] ID ${id}`);
  res.json({ mensaje: "Alarma eliminada del servidor" });
});

// =========================================================================
// 4. RELOJ CADA MINUTO (Reinicio 12:00 AM y envío de WhatsApp)
// =========================================================================
cron.schedule("* * * * *", async () => {
  const ahora = new Date(new Date().toLocaleString("en-US", { timeZone: ZONA_HORARIA }));
  const hh = String(ahora.getHours()).padStart(2, "0");
  const mm = String(ahora.getMinutes()).padStart(2, "0");
  const horaActual = `${hh}:${mm}`;
  const hoy = fechaLocalStr();

  let alarmas = leerAlarmas();
  let huboCambios = false;

  for (let i = 0; i < alarmas.length; i++) {
    // 1. Reinicio automático a las 12:00 AM al cambiar de día
    if (alarmas[i].ok && alarmas[i].fechaUltimaToma !== hoy) {
      alarmas[i].ok = false;
      alarmas[i].fechaUltimaToma = "";
      huboCambios = true;
    }

    // 2. Envío de WhatsApp si el cliente API está listo, está pendiente, coincide la hora y hay número
    if (clienteWA && !alarmas[i].ok && alarmas[i].h === horaActual && alarmas[i].telefono) {
      const mensaje = `💖 *Amor Medicina*\n\n⏰ ¡Hola mi vida! Ya es hora de tu *${alarmas[i].n}*.\n📝 _${alarmas[i].o}_\n\nRecuerda que tu bb necesita ser fuerte y grande. ¡Te amo muchísimo! 🥰`;
      try {
        await clienteWA.messages.create({
          body: mensaje,
          from: NUMERO_ORIGEN,
          to: alarmas[i].telefono
        });
        console.log(`[WHATSAPP ENVIADO] ${horaActual} -> ${alarmas[i].telefono}`);
      } catch (err) {
        console.error(`[ERROR WHATSAPP] ${err.message}`);
      }
    }
  }

  if (huboCambios) {
    guardarAlarmas(alarmas);
  }
}, {
  timezone: ZONA_HORARIA
});

app.listen(PUERTO, () => {
  console.log(`🚀 Servidor Amor Medicina (WhatsApp) activo en puerto ${PUERTO}`);
});
