import assert from 'assert';
import { afterEach, describe, it } from 'node:test';

import axios from 'axios';

import Layers from '../squad-server/layers/layers.js';

const layerList = (rawName, unitName) => ({
  Maps: [
    {
      rawName,
      levelName: rawName,
      Name: rawName,
      teamConfigs: { team1: { defaultFactionUnit: 'USA_CombinedArms' }, team2: {} }
    }
  ],
  Units: { USA_CombinedArms: { displayName: unitName } }
});

const lists = {
  'https://example.test/vanilla.json': layerList('Narva_AAS_v1', 'Vanilla unit'),
  'https://example.test/supermod.json': layerList('SU_Narva_AAS_v1', 'SuperMod unit')
};

const originalGet = axios.get;

describe('Layers', () => {
  afterEach(() => {
    axios.get = originalGet;
  });

  it('loads every configured list and resolves units from the layer’s own list', async () => {
    axios.get = async (url) => ({ data: lists[url] });
    Layers.layerLists = Object.keys(lists);

    await Layers.pull(true);

    assert.equal(Layers.layers.length, 2);
    assert.equal((await Layers.getLayerById('Narva_AAS_v1')).teams[0].name, 'Vanilla unit');
    assert.equal((await Layers.getLayerById('SU_Narva_AAS_v1')).teams[0].name, 'SuperMod unit');
  });
});
