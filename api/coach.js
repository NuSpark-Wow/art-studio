// The Art Studio — Mr. Paul API (Vercel serverless function)
// Needs env var ANTHROPIC_API_KEY. Optional: ALLOWED_ORIGINS (comma list), MODEL.

const MODEL = process.env.MODEL || 'claude-sonnet-5-5';

const STYLES = ['Renaissance','Baroque','Romanticism','Realism','Impressionism','Post-Impressionism','Cubism','Surrealism',
  'Abstract Expressionism','Pop Art','Watercolor','Oil Painting','Charcoal (Black & White)','Pastel','Cartoonish'];
const BRUSHES = ['watercolor','charcoal','pastel','pencil','ink','oil','marker','dots','facet','smudge','blend'];
const FIX_TOOLS = ['heal','blend','smudge','eraser','watercolor','charcoal','pastel','pencil','ink','oil','marker','dots','facet'];
const img = data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });

const PERSONA = `You are Mr. Paul, a warm, encouraging art teacher inside "The Art Studio", an online painting tool from NuSpark Publishing.
Speak clearly and simply to curious beginners of any age. Be friendly and specific. No baby talk, few exclamation points.
Accuracy matters: never invent artists, dates, artworks, quotes or facts. If you are unsure of something, leave it out.
Keep everything family-friendly. If asked for anything inappropriate, politely steer back to art.
Do not reproduce or recreate copyrighted characters, logos or specific famous artworks; suggest original ideas inspired by a style instead.
The studio's brushes: watercolor, charcoal, pastel, pencil, ink, oil, marker (flat color), dots (Pop Art dots), facet (Cubist shapes), smudge, blend.
The studio has a Background layer and a Subject layer that get combined, a "Trace a Picture" option (a faded photo, selfie or outline the user paints over; call it the tracing picture, never a guide), and a Finishing Room with heal, blend, stray-mark removal and color adjustments.`;

const JSON_RULE = 'Reply with ONE valid JSON object only. No markdown, no code fences, no text before or after.';

function bad(res, code, msg) { res.status(code).json({ error: msg }); }

function extractJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { return null; }
}

async function callClaude(system, content, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] })
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    console.error('Anthropic error', r.status, t.slice(0, 500));
    throw new Error('upstream');
  }
  const data = await r.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

const str = (v, max) => String(v == null ? '' : v).slice(0, max).trim();

// Per-visitor limit: coach requests per hour
const HOURLY_LIMIT = 60;
const hits = new Map();
function overLimit(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  if (list.length >= HOURLY_LIMIT) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list);
  if (hits.size > 20000) hits.clear();
  return false;
}

module.exports = async (req, res) => {
  if (!(await require("./_lwgate")(req, res, "art-studio"))) return;
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  if (allowed.length && !allowed.includes(origin)) return bad(res, 403, 'This tool only works on NuSpark sites.');
  if (req.method !== 'POST') return bad(res, 405, 'Use POST.');
  if (overLimit(req)) return bad(res, 429, "You've been busy in the studio! Please take a short break and try again in a little while.");
  if (!process.env.ANTHROPIC_API_KEY) return bad(res, 500, 'Mr. Paul is not set up yet (missing API key).');

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const mode = str(body.mode, 20);

  try {
    let system = PERSONA + '\n' + JSON_RULE, content, maxTokens = 900;

    if (mode === 'vision') {
      const vision = str(body.vision, 600);
      if (vision.length < 3) return bad(res, 400, 'Tell Mr. Paul what you want to paint.');
      content = `A student wants to paint: "${vision}"
Recommend how to approach it. Return JSON:
{"summary":"2 friendly sentences about the idea",
 "styles":[{"name":"one of: ${STYLES.join(' | ')}","why":"1-2 sentences on why it suits this idea"}],  (exactly 3, different styles)
 "composition":"2-3 sentences: where to place the subject, horizon and main shapes",
 "palette":["#hex", ...5 colors that suit the idea],
 "order":["3 to 5 short steps, background first, then the subject, then finishing touches"],
 "subject":"the main subject in 2-5 words, e.g. a running dog"}`;
    } else if (mode === 'lesson') {
      const style = str(body.style, 60);
      if (!style) return bad(res, 400, 'Name a style.');
      maxTokens = 1400;
      content = `Teach a short beginner lesson on the art style or medium: "${style}".
If it is not a real art style or medium, pick the closest real one and say so in "about".
Return JSON:
{"name":"proper style name","era":"where and roughly when (only if well established)","about":"2 sentences",
 "artists":["2-3 real, well-known artists strongly associated with it"],
 "techniques":["3-4 short techniques a beginner can try"],
 "tip":"one paint-along tip",
 "brushes":["2-4 from: ${BRUSHES.join(', ')}"],
 "palette":["#hex", ...6 colors typical of the style],
 "paper":"one of: cold, smooth, toned, canvas",
 "history":"2-3 sentences: when and where it began, why, and how it influenced art",
 "artistInfo":[{"name":"real artist","known":"one line on what they are known for"}],  (2-4, only real, well-documented artists)
 "works":[{"title":"real, famous work","artist":"its artist","year":"year or range"}]}  (2-4, only real, well-documented works; family-friendly; leave out anything you are unsure of)`;
    } else if (mode === 'outline') {
      const subject = str(body.subject, 80);
      if (!subject) return bad(res, 400, 'Say what to outline.');
      maxTokens = 2500;
      content = `Draw a simple, clean line-drawing guide of: "${subject}" for a beginner to paint over.
Use an SVG coordinate space of width 1000 and height 750. Keep the drawing centered, filling about 60-80% of the space.
Use bold, simple outline shapes only (like a coloring book): main body shapes and a few key details. 6 to 30 paths.
If the subject is a copyrighted character or logo, draw a generic original version instead.
Return JSON: {"paths":["SVG path d strings using only M L H V C S Q T A Z commands and numbers"],"note":"one short sentence on how to paint over it"}`;
    } else if (mode === 'check') {
      const image = str(body.image, 2000000);
      if (image.length < 100) return bad(res, 400, 'No painting received.');
      const style = str(body.style, 60), vision = str(body.vision, 600);
      maxTokens = 1600;
      content = [img(image), { type: 'text', text: `This is a student's painting${style ? ` in the style of ${style}` : ''}${vision ? `. Their idea: "${vision}"` : ''}.
Give encouraging, specific feedback as an art teacher, and point out spots that need fixing: stray marks or specks, rough or pasted-looking edges, gaps, or areas that clash with the style.
For every spot, tell the student EXACTLY what to do, step by step, using the studio's real tools and controls:
- Touch-up tools (left side): Heal (covers marks with surrounding colors), Blend (softens and mixes), Smudge (drags paint), Eraser, and Paint (uses a paint brush: watercolor, charcoal, pastel, pencil, ink, oil, marker, dots, facet).
- Controls (right side): Color picker, palette circles, "Pick color" eyedropper (tap it, then tap the painting), Brush size slider (2-140), Strength slider.
Steps must be short actions a beginner can follow, naming the exact tool, slider and setting, e.g. "Tap Blend on the left." "Set Brush size to about 25." "Brush gently along the edge of the dog."
Return JSON:
{"summary":"2 warm sentences",
 "strengths":["2 specific things that work"],
 "tips":["2 big-picture suggestions for next time"],
 "spots":[{"x":0.0-1.0 (fraction of width from left),"y":0.0-1.0 (fraction of height from top),"r":0.02-0.12 (radius as fraction of width),
   "title":"what's wrong, under 10 words",
   "steps":["3-5 instructions, each one short action, no numbers in front"],
   "tool":"one of: ${FIX_TOOLS.join(', ')}",
   "color":"#hex to paint with if the fix needs paint (match the surrounding color), otherwise null",
   "size":brush size number 2-140}]}
Include 0 to 6 spots, only where something truly needs attention.` }];
    } else if (mode === 'ask') {
      const q = str(body.question, 500);
      if (!q) return bad(res, 400, 'Ask a question.');
      const style = str(body.style, 60), vision = str(body.vision, 600), image = str(body.image, 2000000);
      maxTokens = 700;
      const text = `${style ? `Current style: ${style}. ` : ''}${vision ? `Student's idea: "${vision}". ` : ''}${image ? 'The image is their painting so far. ' : ''}
Student's question: "${q}"
Answer in 2-6 short sentences as Mr. Paul. Stay on art, painting and using the studio.
Return JSON: {"answer":"your answer"}`;
      content = image.length > 100
        ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } }, { type: 'text', text }]
        : text;
    } else if (mode === 'pro') {
      const image = str(body.image, 2000000);
      if (image.length < 100) return bad(res, 400, 'No painting received.');
      const style = str(body.style, 60) || 'the style that best suits it', vision = str(body.vision, 600), portrait = !!body.portrait;
      maxTokens = 900;
      content = [img(image), { type: 'text', text: `This is a student's painting. They will upload it to an AI image generator (ChatGPT or Gemini) together with a prompt, to see how a professional would paint the same picture in ${style}.
Write that prompt. It must:
- Tell the generator to repaint THE ATTACHED IMAGE, keeping the student's composition, subject, placement and main colors.
- Describe what is in the picture so the generator keeps it.
- Add rich, specific ${style} technique: brushwork, light and shadow, color handling, texture, surface and mood.
${portrait ? "- This is a self-portrait: keep the person's likeness, pose and features recognizable.\n" : ''}${vision ? `- The student's idea was: "${vision}".\n` : ''}- Be family-friendly. Describe techniques instead of naming copyrighted characters or brands.
- 80 to 160 words, written directly to the image generator.
Return JSON: {"prompt":"the prompt"}` }];
    } else if (mode === 'compare') {
      const mine = str(body.mine, 2000000), ai = str(body.ai, 2000000), style = str(body.style, 60);
      if (mine.length < 100 || ai.length < 100) return bad(res, 400, 'Both pictures are needed.');
      maxTokens = 900;
      content = [{ type: 'text', text: "Picture 1, the student's own painting:" }, img(mine), { type: 'text', text: 'Picture 2, the AI version made from it:' }, img(ai),
        { type: 'text', text: `Compare them as an encouraging art teacher${style ? `, focusing on ${style} technique` : ''}. Celebrate the student's work, then teach.
Return JSON: {"summary":"2 warm sentences","differences":["3-4 specific techniques the AI version used differently (brushwork, light, color, texture, detail)"],"tryNext":["2-3 doable things the student can try in their own painting, naming studio tools where useful"]}` }];
    } else if (mode === 'stylize') {
      const image = str(body.image, 2000000), style = str(body.style, 60);
      if (image.length < 100) return bad(res, 400, 'No photo received.');
      if (!style) return bad(res, 400, 'Pick a style.');
      maxTokens = 900;
      content = [img(image), { type: 'text', text: `A user of the Photo Styling Room wants an AI image generator (ChatGPT or Gemini) to turn the attached photo into an original painting in this style: ${style}.
Write the prompt they will paste in with the photo. It must:
- Tell the generator to repaint THE ATTACHED PHOTO as a painting, keeping the same subject, composition, layout and pose.
- Briefly describe what is in the photo so the generator keeps it.
- Add rich, specific ${style} technique: brushwork or marks, light and shadow, color handling, texture, surface and mood.
- If there are people, keep their likeness, pose and features recognizable and respectful.
- Be family-friendly. Describe techniques instead of naming copyrighted characters or brands. Do not add text or a signature.
- 80 to 160 words, written directly to the image generator.
If the photo is inappropriate for a family audience, return {"prompt":"","note":"a kind one-sentence reason"}.
Return JSON: {"prompt":"the prompt"}` }];
    } else if (mode === 'edit') {
      const image = str(body.image, 2000000), change = str(body.change, 200), style = str(body.style, 60);
      if (image.length < 100) return bad(res, 400, 'No picture received.');
      if (change.length < 3) return bad(res, 400, 'Say what to change.');
      maxTokens = 700;
      content = [img(image), { type: 'text', text: `A user wants an AI image generator (ChatGPT or Gemini) to make one change to the attached painting: "${change}".${style ? ` The painting's style is ${style}.` : ''}
Write the prompt they will paste in with the picture. It must:
- Tell the generator to edit THE ATTACHED IMAGE and make only this change: ${change}.
- Say to keep everything else exactly the same: composition, subjects, colors, lighting and painting style.
- Say to paint any new element in the same painting technique, brushwork, light and color palette so it blends in naturally, and describe where it should go if the user implied a place.
- Be family-friendly. No text or signature.
- 50 to 120 words, written directly to the image generator.
If the change is inappropriate for a family audience, return {"prompt":"","note":"a kind one-sentence reason and a suggestion"}.
Return JSON: {"prompt":"the prompt"}` }];
    } else {
      return bad(res, 400, 'Unknown request.');
    }

    const raw = await callClaude(system, content, maxTokens);
    const json = extractJson(raw);
    if (!json) return bad(res, 502, 'Mr. Paul lost his train of thought. Please try again.');

    if (mode === 'vision' && Array.isArray(json.styles)) json.styles = json.styles.filter(s => s && STYLES.includes(s.name)).slice(0, 3);
    if (mode === 'check' && Array.isArray(json.spots)) json.spots = json.spots.slice(0, 6).map(sp => Object.assign(sp, { tool: FIX_TOOLS.includes(sp.tool) ? sp.tool : 'heal', color: /^#[0-9a-fA-F]{6}$/.test(sp.color || '') ? sp.color : null }));
    if (mode === 'lesson' && Array.isArray(json.brushes)) json.brushes = json.brushes.filter(b => BRUSHES.includes(b)).slice(0, 4);
    if (Array.isArray(json.palette)) json.palette = json.palette.filter(c => /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, 6);
    return res.status(200).json(json);
  } catch (e) {
    console.error(e);
    return bad(res, 502, 'Mr. Paul is busy right now. Please try again in a moment.');
  }
};
