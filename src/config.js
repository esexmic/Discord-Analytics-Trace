'use strict';

require('dotenv').config();

/**
 * Configuración de arranque. Todo lo que es secreto o se puede cambiar desde el
 * panel vive en src/settings.js; acá quedan solo las perillas operativas que se
 * leen una vez y no cambian en caliente.
 *
 * Nada es obligatorio: el proceso arranca sin credenciales y el panel muestra
 * el asistente de configuración. Eso permite instalar, abrir el dashboard y
 * pegar token/keys desde ahí sin tocar archivos ni reiniciar.
 */

function list(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function flag(name) {
  return String(process.env[name] || '').toLowerCase() === 'true';
}

module.exports = {
  port: Number.parseInt(process.env.PORT || '3000', 10),
  trackAll: flag('TRACK_ALL'),
  seedTargets: list(process.env.TARGETS),
  alertWebhook: String(process.env.ALERT_WEBHOOK || '').trim(),
  // Origen público del panel. El webhook de actividad lo usa para el avatar del
  // log (/logo.jpg); sin esta variable se deduce del host con el que se entra.
  publicUrl: String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
  selfPresence: String(process.env.SELF_PRESENCE || '').trim(),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
};
