import axios from 'axios';

import Logger from 'core/logger';

import Layer from './layer.js';

const DEFAULT_LAYER_LISTS = [
  'https://raw.githubusercontent.com/fantinodavide/SquadLayerList/main/layers.json'
];

class Layers {
  constructor() {
    this.layers = [];
    this.layerLists = DEFAULT_LAYER_LISTS;

    this.pulled = false;
  }

  async pull(force = false) {
    if (this.pulled && !force) {
      Logger.verbose('Layers', 2, 'Already pulled layers.');
      return;
    }
    if (force) Logger.verbose('Layers', 1, 'Forcing update to layer information...');

    const layers = [];
    let skipped = 0;

    Logger.verbose('Layers', 1, `Pulling layers from ${this.layerLists.join(', ')}...`);
    // A list that fails is skipped, so one unreachable mod list does not stop SquadJS from starting.
    const responses = await Promise.all(
      this.layerLists.map((url) =>
        axios.get(url).catch((err) => {
          Logger.verbose('Layers', 1, `Failed to pull layers from ${url}: ${err.message}`);
          return null;
        })
      )
    );

    for (const [index, response] of responses.entries()) {
      if (!Array.isArray(response?.data?.Maps)) {
        if (response) Logger.verbose('Layers', 1, `No layer list at ${this.layerLists[index]}.`);
        continue;
      }

      // Unit ids repeat across lists with different contents, so each layer resolves against its own list.
      const units = response.data.Units || {};
      for (const layer of response.data.Maps) {
        try {
          layers.push(new Layer(layer, units));
        } catch (err) {
          skipped++;
          Logger.verbose('Layers', 1, `Skipped layer ${layer?.rawName}: ${err.message}`);
        }
      }
    }

    this.layers = layers;

    Logger.verbose(
      'Layers',
      1,
      `Pulled ${this.layers.length} layers` + (skipped > 0 ? ` (skipped ${skipped}).` : '.')
    );

    this.pulled = true;

    return this.layers;
  }

  async getLayerByCondition(condition) {
    await this.pull();

    const matches = this.layers.filter(condition);
    if (matches.length === 1) return matches[0];

    return null;
  }

  getLayerById(layerId) {
    return this.getLayerByCondition((layer) => layer.layerid === layerId);
  }

  getLayerByClassname(classname) {
    return this.getLayerByCondition((layer) => layer.classname === classname);
  }
}

export default new Layers();
