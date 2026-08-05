// netlify/functions/extract-receipt.js
//
// Esta función corre en el servidor de Netlify, no en el navegador del usuario.
// Por eso la ANTHROPIC_API_KEY puede vivir aquí de forma segura: nunca se manda
// al cliente, solo el resultado ya procesado (el JSON del recibo).
//
// El navegador le manda la foto en base64 -> esta función se la pasa a Claude
// con visión -> Claude devuelve el JSON del recibo -> esta función se lo
// regresa al navegador.

const RECEIPT_PROMPT = `Eres un sistema experto en extraer datos de facturas de restaurante (Sysco, US Foods, Cintas, proveedores locales de produce, etc).

Analiza la(s) imagen(es) de esta factura y extrae la información en JSON puro (sin markdown, sin backticks, sin texto extra antes o después).

Si recibes más de una imagen, son páginas consecutivas de UNA SOLA factura (por ejemplo página 1 y página 2 del mismo recibo, en ese orden). Combina los productos de todas las páginas en una sola lista "items", sin duplicar información — el encabezado (proveedor, fecha) suele repetirse en cada página, úsalo solo una vez.

REGLAS IMPORTANTES:
- Si un precio está tachado y hay uno escrito a mano al lado, usa el escrito a mano (es la corrección final), no el original tachado.
- Ignora líneas de "GROUP TOTAL", subtotales de sección, encabezados de categoría (FROZEN, PRODUCE, DRY, etc), cargos de flete/fuel surcharge, e impuestos — esas NO son productos individuales.
- "total_price" es el precio EXTENDIDO de esa línea (cantidad x precio unitario), no el precio unitario solo.
- Si no puedes leer un campo con confianza razonable, usa tu mejor estimación pero marca "confidence" como "baja".
- Las cantidades y precios son siempre números (usa punto decimal), nunca strings.
- La fecha va en formato YYYY-MM-DD. Si no la puedes determinar, usa null.

Devuelve exactamente este formato:

{
  "supplier": "string",
  "date": "YYYY-MM-DD o null",
  "invoice_total": number o null,
  "items": [
    {
      "name": "string",
      "quantity": number,
      "unit": "string (LB, CS, CT, unidad, etc)",
      "total_price": number,
      "confidence": "alta" | "media" | "baja"
    }
  ]
}`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Falta configurar ANTHROPIC_API_KEY en Netlify' }) };
  }

  // Acepta tanto el formato nuevo ("images": [{base64, mediaType}, ...], una o
  // varias páginas) como el formato viejo de una sola imagen, por compatibilidad.
  let images;
  try {
    const parsed = JSON.parse(event.body || '{}');
    if (Array.isArray(parsed.images) && parsed.images.length > 0) {
      images = parsed.images;
    } else if (parsed.imageBase64) {
      images = [{ base64: parsed.imageBase64, mediaType: parsed.mediaType || 'image/jpeg' }];
    }
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Body inválido' }) };
  }

  if (!images || images.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta la imagen' }) };
  }
  if (images.length > 5) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Máximo 5 páginas por recibo' }) };
  }

  const imageContentBlocks = images.map(img => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.base64 }
  }));

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 2500,
        messages: [
          {
            role: 'user',
            content: [
              ...imageContentBlocks,
              { type: 'text', text: RECEIPT_PROMPT }
            ]
          }
        ]
      })
    });

    const data = await response.json();

    if (data.error) {
      return { statusCode: 502, body: JSON.stringify({ error: data.error.message || 'Error de la API de Claude' }) };
    }

    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock || !textBlock.text) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Claude no devolvió texto' }) };
    }

    let receiptData;
    try {
      const clean = textBlock.text.replace(/```json|```/g, '').trim();
      receiptData = JSON.parse(clean);
    } catch (e) {
      return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo interpretar la respuesta de Claude' }) };
    }

    return { statusCode: 200, body: JSON.stringify(receiptData) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Error interno' }) };
  }
};
