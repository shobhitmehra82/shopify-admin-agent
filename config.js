// Tunables for the chatbot. Edit the defaults here, or override any of them
// with the matching environment variable in .env — handy for trying a value
// without editing tracked code.
//
// Read by shopifyQueries.js (query limits), mcp/tools.js (tool schemas) and
// server/index.js, which publishes the display limits to the UI via
// /api/health so the browser never hard-codes them.

/** Positive integer from env, else the default. Guards against "", "abc" and 0. */
function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const config = {
  products: {
    // How many products a search returns — i.e. how many tiles the carousel
    // shows. This is the one to change if the carousel feels too short or long.
    displayLimit: positiveInt(process.env.PRODUCT_DISPLAY_LIMIT, 6),

    // Hard ceiling. The model can ask for more than displayLimit ("show me 20
    // shirts") but never more than this, so one question cannot pull the whole
    // catalogue into the conversation.
    maxDisplayLimit: positiveInt(process.env.PRODUCT_MAX_DISPLAY_LIMIT, 24),

    // Variants listed per product, which is what the tile's size/colour picker
    // is built from.
    variantLimit: positiveInt(process.env.PRODUCT_VARIANT_LIMIT, 10),
  },

  customers: {
    displayLimit: positiveInt(process.env.CUSTOMER_DISPLAY_LIMIT, 5),
    maxDisplayLimit: positiveInt(process.env.CUSTOMER_MAX_DISPLAY_LIMIT, 25),
  },

  orders: {
    displayLimit: positiveInt(process.env.ORDER_DISPLAY_LIMIT, 10),
    maxDisplayLimit: positiveInt(process.env.ORDER_MAX_DISPLAY_LIMIT, 50),
  },

  voice: {
    // How long the mic stays open per press. Recording stops on its own after
    // this, then the transcript is sent as a message — no second click.
    //
    // Raise it if commands are getting cut off mid-sentence; 3s suits short
    // ones like "show me some bracelets". Clamped to 1-60s, because 0 would
    // capture nothing and a very long window just delays every send.
    recordingSeconds: clamp(positiveInt(process.env.VOICE_RECORDING_SECONDS, 3), 1, 60),
  },
};

// A displayLimit above its own ceiling would silently clamp on every call, so
// fail loudly at startup instead of confusing someone later. Groups without a
// limit pair (voice) are skipped rather than compared as undefined.
for (const [group, values] of Object.entries(config)) {
  if (values.displayLimit === undefined || values.maxDisplayLimit === undefined) continue;
  if (values.displayLimit > values.maxDisplayLimit) {
    throw new Error(
      `config.${group}: displayLimit (${values.displayLimit}) exceeds ` +
        `maxDisplayLimit (${values.maxDisplayLimit})`
    );
  }
}

module.exports = config;
