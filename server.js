const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors()); // Permite conexiones desde https://amor-medicina.netlify.app
app.use(express.json()); // Lee los datos JSON enviados por tu página

// =========================================================================
// 1. VARIABLES DE CONFIGURACIÓN DEL SERVIDOR (CORREO ELECTRÓNICO)
// =========================================================================
const PUERTO       = process.env.PORT || 3000;
const ZONA_HORARIA = "America/Mexico_City";
const EMAIL_USER   = process.env.EMAIL_USER || ""; // Tu correo Gmail remitente
const EMAIL_PASS   = process.env.EMAIL_PASS || ""; // Contraseña de aplicación de 16 letras

const ARCHIVO_DB = path.join(__dirname, "alarmas.json");

// Inicializa el transportador de correo solo si existen credenciales configuradas
const transportador = (EMAIL_USER && EMAIL_PASS)
  ? nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS
      }
    })
  : null;

// =========================================================================
// 2. FUNCIONES DE ALMACENAMIENTO Y VALIDACIÓN DE CORREO
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

function limpiarCorreo(correo) {
  const limpio = String(correo || "").trim().toLowerCase();
  return limpio.includes("@") ? limpio : "";
}

function fechaLocalStr() {
  const ahora = new Date(new Date().toLocaleString("en-US", { timeZone: ZONA_HORARIA }));
  return ahora.getFullYear() + "-" + (ahora.getMonth() + 1) + "-" + ahora.getDate();
}

// =========================================================================
// 3. RUTAS DE LA API (Conecta tu página web con el servidor)
// =========================================================================

app.get("/", (req, res) => {
  res.send("💖 Servidor Amor Medicina (Correo) activo. Estado SMTP: " + (transportador ? "Conectado" : "Esperando credenciales"));
});

app.get("/api/alarmas", (req, res) => {
  res.json(leerAlarmas());
});

// Guarda o actualiza una alarma individual
app.post("/api/alarmas", (req, res) => {
  const { id, n, h, o, ok, correo } = req.body;
  if (!id || !n || !h) {
    return res.status(400).json({ error: "Faltan datos obligatorios (id, nombre u hora)." });
  }

  const correoDestino = limpiarCorreo(correo);
  let alarmas = leerAlarmas();
  alarmas = alarmas.filter((item) => item.id !== id);
  alarmas.push({
    id: id,
    n: n,
    h: h,
    o: o || "Con mucho amor",
    correo: correoDestino,
    ok: Boolean(ok),
    fechaUltimaToma: ok ? fechaLocalStr() : ""
  });

  guardarAlarmas(alarmas);
  console.log(`[ALARMA GUARDADA] ${n} (${h}) -> Destino: ${correoDestino || "Sin correo (apagada)"}`);
  res.json({ mensaje: "Alarma sincronizada", correo: correoDestino });
});

// Actualiza o elimina el correo electrónico en TODAS las alarmas guardadas
app.put("/api/correo", (req, res) => {
  const { correo } = req.body;
  const correoDestino = limpiarCorreo(correo);
  let alarmas = leerAlarmas();

  for (let i = 0; i < alarmas.length; i++) {
    alarmas[i].correo = correoDestino;
  }

  guardarAlarmas(alarmas);
  console.log(`[CORREO ACTUALIZADO] Nuevo destino: ${correoDestino || "VACÍO (Avisos desactivados)"}`);
  res.json({ mensaje: "Correo actualizado en el servidor", correo: correoDestino });
});

// Marca una medicina como tomada hoy (pausa el envío de correo por hoy)
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
// 4. RELOJ CADA MINUTO (Reinicio 12:00 AM y envío de Correo Electrónico)
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

    // 2. Envío de correo si el transportador está activo, está pendiente, coincide la hora y hay correo
    if (transportador && !alarmas[i].ok && alarmas[i].h === horaActual && alarmas[i].correo) {
      const htmlCorreo = `
        <div style="font-family: Arial, sans-serif; background:#FFF5F7; padding:24px; border-radius:16px; max-width:460px; margin:auto; border:2px solid #FFE3EC;">
          <h2 style="color:#FF5C8A; margin-top:0;">💖 ¡Hora de tu medicina, mi vida!</h2>
          <p style="font-size:16px; color:#4A3540;">Ya son las <b>${alarmas[i].h}</b> y es momento de tomar:</p>
          <div style="background:#FFFFFF; padding:14px; border-radius:12px; border-left:5px solid #FF5C8A; margin:14px 0;">
            <strong style="font-size:18px; color:#4A3540;">💊 ${alarmas[i].n}</strong><br>
            <span style="color:#8C6D7C; font-size:14px;">${alarmas[i].o}</span>
          </div>
          <p style="font-size:14px; color:#4A3540;">Recuerda que tu bb necesita ser fuerte y grande. ¡Te amo muchísimo! 🥰</p>
        </div>
      `;

      try {
        await transportador.sendMail({
          from: `"Amor Medicina 💖" <${EMAIL_USER}>`,
          to: alarmas[i].correo,
          subject: `⏰💖 Hora de tu medicina: ${alarmas[i].n}`,
          html: htmlCorreo
        });
        console.log(`[CORREO ENVIADO] ${horaActual} -> ${alarmas[i].correo}`);
      } catch (err) {
        console.error(`[ERROR CORREO] ${err.message}`);
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
  console.log(`🚀 Servidor Amor Medicina (Correo) activo en puerto ${PUERTO}`);
});
