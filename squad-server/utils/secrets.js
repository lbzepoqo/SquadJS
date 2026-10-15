import fs from 'fs';

// A config value written as { "secret": "NAME" } is a reference to a secret, so passwords and tokens can be
// kept out of the config file. The value comes from the environment variable NAME or, if that is not set or empty,
// from the key NAME in the secrets file.
export function isSecretReference(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof value.secret === 'string'
  );
}

export default class Secrets {
  constructor(values = {}, environment = process.env, source = 'the secrets file') {
    this.values = values;
    this.environment = environment;
    this.source = source;
  }

  static fromFile(filePath, environment = process.env) {
    if (!fs.existsSync(filePath)) return new Secrets({}, environment, filePath);

    let values;
    try {
      values = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      throw new Error(`Unable to parse secrets file ${filePath}.`);
    }
    if (values === null || typeof values !== 'object' || Array.isArray(values))
      throw new Error(`Secrets file ${filePath} must contain a JSON object.`);

    return new Secrets(values, environment, filePath);
  }

  get(name, location) {
    // An empty variable counts as unset; hosting panels often export unset variables as empty strings.
    if (this.environment[name]) return this.environment[name];
    if (Object.prototype.hasOwnProperty.call(this.values, name)) return this.values[name];
    throw new Error(
      `${location} refers to secret "${name}", which is neither an environment variable nor a key in ${this.source}.`
    );
  }

  // Replaces every secret reference in value, including inside arrays and objects, and returns the result.
  // The value passed in is not changed.
  resolve(value, location) {
    if (isSecretReference(value)) return this.get(value.secret, location);
    if (Array.isArray(value))
      return value.map((item, index) => this.resolve(item, `${location}[${index}]`));
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.resolve(item, `${location}.${key}`)])
      );
    return value;
  }
}
