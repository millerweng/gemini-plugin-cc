export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  // A flag that works bare (`--multi`) but also takes an inline value
  // (`--multi=security,correctness`). Declaring it boolean instead would coerce the
  // inline value to `true` and silently drop it; declaring it a value option would
  // make the bare form eat the next token, which for these commands is focus text.
  const optionalValueOptions = new Set(config.optionalValueOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  // Commands taking free text (a review focus, a task prompt) legitimately collect
  // unknown tokens as positionals. Commands that take none must not: swallowing a flag
  // makes a no-op look like it worked, which is how `setup --set-review-base <ref>`
  // reported success on a build that had no such flag.
  const rejectUnknownOptions = config.rejectUnknownOptions === true;
  const unknownOption = (token) => {
    const known = [...booleanOptions, ...valueOptions, ...optionalValueOptions].sort();
    return new Error(
      `Unknown option ${token}. This command accepts: ${known.map((name) => `--${name}`).join(", ")}.`
    );
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (optionalValueOptions.has(key)) {
        if (inlineValue === undefined) {
          options[key] = true;
        } else if (inlineValue === "false") {
          options[key] = false;
        } else if (inlineValue === "true") {
          // Coerced for symmetry with "false". Left as a string it reached the lens
          // lookup as a lens literally named "true" and aborted the run.
          options[key] = true;
        } else {
          options[key] = inlineValue;
        }
        continue;
      }

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      if (rejectUnknownOptions) {
        throw unknownOption(`--${rawKey}`);
      }
      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (optionalValueOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    if (rejectUnknownOptions) {
      throw unknownOption(token);
    }
    positionals.push(token);
  }

  return { options, positionals };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
