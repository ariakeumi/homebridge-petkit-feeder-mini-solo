'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const EventEmitter = require('events');

// Exercise the plugin through Homebridge's public registration entry point.
class MockCharacteristic extends EventEmitter {
    updateValue(value) { this.value = value; return this; }
    setProps(props) { this.props = props; return this; }
}

class MockService {
    constructor(name, subtype) {
        this.UUID = this.constructor.UUID;
        this.displayName = name;
        this.subtype = subtype;
        this.characteristics = new Map();
    }
    getCharacteristic(type) {
        if (!this.characteristics.has(type)) this.characteristics.set(type, new MockCharacteristic());
        return this.characteristics.get(type);
    }
    setCharacteristic(type, value) { this.getCharacteristic(type).updateValue(value); return this; }
    testCharacteristic(type) { return this.characteristics.has(type); }
    addCharacteristic(type) { return this.getCharacteristic(type); }
    addOptionalCharacteristic(type) { return this.getCharacteristic(type); }
    removeCharacteristic(characteristic) {
        for (const [type, value] of this.characteristics) {
            if (value === characteristic) this.characteristics.delete(type);
        }
    }
    setPrimaryService() {}
}

class MockAccessory {
    constructor(name, uuid) {
        this.displayName = name;
        this.UUID = uuid;
        this.services = [];
        this.context = {};
    }
    addService(type, name, subtype) {
        const service = new type(name, subtype);
        this.services.push(service);
        return service;
    }
    getService(type) { return this.services.find(service => service.UUID === type.UUID); }
}

const Service = {};
for (const name of ['Switch', 'Fan', 'OccupancySensor', 'FilterMaintenance', 'Battery', 'AccessoryInformation']) {
    Service[name] = class extends MockService {};
    Service[name].UUID = name;
}
const Characteristic = {
    ChargingState: {CHARGING: 1, NOT_CHARGING: 0, NOT_CHARGEABLE: 2},
    StatusLowBattery: {BATTERY_LEVEL_LOW: 1, BATTERY_LEVEL_NORMAL: 0},
};
for (const name of ['On', 'RotationSpeed', 'OccupancyDetected', 'FilterChangeIndication', 'FilterLifeLevel',
    'ResetFilterIndication', 'BatteryLevel', 'Name', 'ConfiguredName', 'Identify', 'Manufacturer', 'Model',
    'SerialNumber', 'FirmwareRevision']) Characteristic[name] = name;

let Platform;
require('../index')({
    platformAccessory: MockAccessory,
    hap: {Service, Characteristic, uuid: {generate: id => 'uuid-' + id}},
    registerPlatform: (plugin, name, constructor) => { Platform = constructor; },
});

const silentLog = () => {};
silentLog.warn = silentLog.error = silentLog;

function createPlatform(overrides = {}) {
    const api = new EventEmitter();
    api.platformAccessory = MockAccessory;
    api.registerPlatformAccessories = () => {};
    const platform = new Platform(silentLog, Object.assign({
        region: 'CN', headers: [{key: 'X-Session', value: 'test-session'}],
        enable_manualLock: true, enable_lightMode: true, enable_desiccant: true,
        alert_desiccant_threshold: 7, enable_autoreset_desiccant: false,
    }, overrides), api);
    platform.setupPolling = () => {};
    return platform;
}

// Synthetic device data: no account data, serial numbers or network identifiers.
function deviceReply(model) {
    return {result: {
        name: model + ' feeder', sn: 'test-serial', firmware: '1.0.0', timezone: 'Asia/Shanghai',
        state: Object.assign({food: 1, batteryPower: 4, batteryStatus: 0, desiccantLeftDays: 29},
            model === 'D4' ? {pim: 1, batteryPower: 0, batteryStatus: 0} : {}),
        settings: {manualLock: 0, lightMode: 0},
    }};
}

async function createDevice(platform, model) {
    const validDevice = {id: model + '-id', type: model, name: model + ' feeder'};
    platform.http_getDeviceInfo = async () => deviceReply(model);
    const registered = new Promise(resolve => { platform.api.registerPlatformAccessories = resolve; });
    platform.initializeDevice(validDevice);
    await registered;
    return platform.accessories.get('uuid-' + validDevice.id);
}

// The UI server starts itself; inject just its Homebridge transport and HTTP client.
function loadUiServer(request) {
    let instance;
    class UiServer {
        constructor() { instance = this; this.handlers = new Map(); }
        onRequest(name, handler) { this.handlers.set(name, handler); }
        ready() {}
    }
    class RequestError extends Error {}
    const filename = path.resolve(__dirname, '../homebridge-ui/server.js');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        require: name => {
            if (name === 'axios') return {request};
            if (name === '@homebridge/plugin-ui-utils') return {HomebridgePluginUiServer: UiServer, RequestError};
            if (name === './public/region-servers.js') return require('../homebridge-ui/public/region-servers');
            return require(name);
        },
    }, {filename});
    return instance;
}

const tests = [];
function test(name, run) { tests.push({name, run}); }

test('owned device discovery recognizes Mini and Solo with mixed type casing', async () => {
    const platform = createPlatform();
    platform.http_request = async () => ({result: [{groupId: 'family', deviceList: [
        {deviceId: 'mini', deviceType: 'feedermini', deviceName: 'Mini'},
        {deviceId: 'solo', deviceType: 'd4', deviceName: 'Solo'},
        {deviceId: 'other', deviceType: 'T4', deviceName: 'Other'},
    ]}]});
    const devices = platform.praseGetOwnedDevice(await platform.http_getOwnDevice(platform.platformConf));
    assert.deepStrictEqual(devices.map(device => [device.id, device.type]), [['mini', 'FeederMini'], ['solo', 'D4']]);
    assert.strictEqual(platform.normalizeDeviceType('D4'), 'D4');
    assert.strictEqual(platform.normalizeDeviceType('D4H'), 'D4H');
});

test('shared Solo discovery fetches its name using the d4 detail endpoint', async () => {
    const platform = createPlatform();
    platform.http_request = async options => {
        const url = new URL(options.url);
        if (url.pathname.endsWith('/group/family/list')) return {result: [{groupId: 'family', deviceList: []}]};
        if (url.pathname.endsWith('/discovery/device_roster_v2')) {
            return {result: {devices: [{id: 'solo', type: 'd4', deviceTypeAndId: 'd4_solo'}]}};
        }
        assert.strictEqual(url.pathname, '/6/d4/device_detail');
        assert.strictEqual(url.searchParams.get('id'), 'solo');
        return {result: {name: 'Shared Solo'}};
    };
    const devices = platform.praseGetOwnedDevice(await platform.http_getOwnDevice(platform.platformConf));
    assert.strictEqual(devices[0].name, 'Shared Solo');
    assert.strictEqual(devices[0].type, 'D4');
});

test('HomeKit initializes Solo and Mini together with model-specific ranges and services', async () => {
    const platform = createPlatform();
    const solo = await createDevice(platform, 'D4');
    const mini = await createDevice(platform, 'FeederMini');
    const element = await createDevice(platform, 'Feeder');
    assert.strictEqual(platform.accessories.size, 3);
    for (const [device, max] of [[solo, 5], [mini, 10], [element, 10]]) {
        const props = device.services.meal_amount_service.getCharacteristic(Characteristic.RotationSpeed).props;
        assert.deepStrictEqual(props, {minValue: 0, maxValue: max, minStep: 1});
        assert(device.services.food_storage_service);
        assert(device.services.desiccant_level_service);
        assert(device.services.manualLock_service);
        assert(device.services.lightMode_service);
    }
    assert(solo.services.battery_status_service);
    assert(mini.services.battery_status_service);
    assert.strictEqual(element.services.battery_status_service, undefined);
    assert.strictEqual(solo.config.get('sn'), 'test-serial');
    assert.strictEqual(solo.config.get('timezone'), 'Asia/Shanghai');
    assert.strictEqual(solo.services.battery_status_service.testCharacteristic(Characteristic.BatteryLevel), false);
    assert.strictEqual(solo.services.battery_status_service.getCharacteristic(Characteristic.StatusLowBattery).value, 0);
    assert.strictEqual(mini.services.battery_status_service.getCharacteristic(Characteristic.BatteryLevel).value, 100);
});

test('Solo and Mini food indicators support full, empty and reversed states', async () => {
    const platform = createPlatform();
    for (const model of ['D4', 'FeederMini']) {
        const device = await createDevice(platform, model);
        for (const reverse of [false, true]) {
            device.config.set('reverse_foodStorage_indicator', reverse);
            for (const food of [0, 1]) {
                device.status.food = food;
                assert.strictEqual(Number(device.getFoodStatusForHomebridge()), reverse ? 1 - food : food);
                platform.uploadStatusToHomebridge(device);
                assert.strictEqual(Number(device.services.food_storage_service.getCharacteristic(Characteristic.OccupancyDetected).value), reverse ? 1 - food : food);
            }
        }
    }
});

test('feeding sends the correct amount for every supported portion count', async () => {
    const platform = createPlatform();
    for (const [model, endpoint, max, unit] of [
        ['D4', 'd4/saveDailyFeed', 5, 10],
        ['FeederMini', 'feedermini/save_dailyfeed', 10, 5],
        ['Feeder', 'feeder/save_dailyfeed', 10, 5],
    ]) {
        const device = await createDevice(platform, model);
        let sent = 0;
        platform.http_request = async options => {
            const url = new URL(options.url);
            assert.strictEqual(url.pathname, '/6/' + endpoint);
            assert.strictEqual(url.searchParams.get('deviceId'), model + '-id');
            assert.strictEqual(url.searchParams.get('time'), '-1');
            assert(/^\d{8}$/.test(url.searchParams.get('day')));
            assert.strictEqual(Number(url.searchParams.get('amount')), ++sent * unit);
            assert.strictEqual(options.petkitConf, device.config);
            return {result: {isExecuted: 1}};
        };
        for (let amount = 1; amount <= max; amount++) {
            assert(platform.praseSaveDailyFeedResult(await platform.http_saveDailyFeed(device, amount, -1)));
        }
        assert.strictEqual(sent, max);
    }
});

test('invalid Solo amounts are rejected before any request or saved-state change', async () => {
    const platform = createPlatform();
    const device = await createDevice(platform, 'D4');
    platform.http_request = async () => { throw new Error('Unexpected network request'); };
    for (const amount of [-1, 0, 1.5, 6, 10, NaN]) {
        await assert.rejects(platform.http_saveDailyFeed(device, amount, -1), /Invalid meal amount/);
        if (amount !== 0) {
            let error;
            platform.hb_mealAmount_set(device, amount, value => { error = value; });
            assert(error instanceof Error);
            assert.strictEqual(device.savedData.mealAmount, 2);
        }
    }
    platform.hb_mealAmount_set(device, 0, error => assert.ifError(error));
    assert.strictEqual(device.savedData.mealAmount, 0);
});

test('settings use unprefixed Solo keys and preserve Mini and Element keys', async () => {
    const platform = createPlatform();
    for (const model of ['D4', 'FeederMini', 'Feeder']) {
        const device = await createDevice(platform, model);
        let sent = 0;
        for (const key of ['manualLock', 'lightMode']) {
            platform.http_request = async options => {
                sent++;
                const url = new URL(options.url);
                assert.strictEqual(url.pathname, '/6/' + (model === 'D4' ? 'd4/updateSettings' : model.toLowerCase() + '/update'));
                assert.strictEqual(url.searchParams.get('id'), model + '-id');
                assert.deepStrictEqual(JSON.parse(url.searchParams.get('kv')), {[model === 'D4' ? key : 'settings.' + key]: 1});
                return {result: 'success'};
            };
            assert(platform.praseUpdateDeviceSettingsResult(await platform.http_updateDeviceSettings(device, key, 1)));
        }
        assert.strictEqual(await platform.http_updateDeviceSettings(device, 'unsupported', 1), false);
        assert.strictEqual(sent, 2);
    }
});

test('Solo status, daily feed and desiccant requests use the correct endpoints', async () => {
    const platform = createPlatform();
    const device = await createDevice(platform, 'D4');
    const expected = ['d4/devicestate', 'd4/dailyFeeds', 'd4/desiccantReset'];
    platform.http_request = async options => {
        const url = new URL(options.url);
        const endpoint = expected.shift();
        assert.strictEqual(url.pathname, '/6/' + endpoint);
        assert.strictEqual(url.searchParams.get(endpoint.endsWith('devicestate') ? 'id' : 'deviceId'), 'D4-id');
        if (endpoint.endsWith('dailyFeeds')) assert(/^\d{8}$/.test(url.searchParams.get('days')));
        return {result: 30};
    };
    await platform.http_getDeviceState(device);
    await platform.http_getDeviceDailyFeeds(device);
    await platform.http_resetDesiccant(device);
    assert.strictEqual(expected.length, 0);
    device.status.desiccantLeftDays = 3;
    platform.hb_desiccantIndicator_get(device, (error, value) => { assert.ifError(error); assert.strictEqual(value, 1); });
});

test('Mini battery polling and reads agree at 50% and respect the AC warning option', async () => {
    const platform = createPlatform();
    for (const model of ['FeederMini']) {
        const device = await createDevice(platform, model);
        for (const batteryPower of [0, 2, 4]) {
            for (const batteryStatus of [0, 1]) {
                for (const ignore of [false, true]) {
                    device.config.set('ignore_battery_when_charging', ignore);
                    Object.assign(device.status, {batteryPower, batteryStatus});
                    const expected = batteryPower <= 2 && !(batteryStatus === 0 && ignore) ? 1 : 0;
                    platform.uploadStatusToHomebridge(device);
                    assert.strictEqual(device.services.battery_status_service.getCharacteristic(Characteristic.BatteryLevel).value, batteryPower * 25);
                    assert.strictEqual(device.services.battery_status_service.getCharacteristic(Characteristic.StatusLowBattery).value, expected);
                    platform.hb_deviceStatusLowBattery_get(device, (error, value) => { assert.ifError(error); assert.strictEqual(value, expected); });
                }
            }
        }
    }
});

test('Solo only reports low backup batteries while running on installed batteries', async () => {
    const platform = createPlatform();
    const device = await createDevice(platform, 'D4');
    // Captured Solo AC state: pim=1, batteryPower=0, batteryStatus=0.
    // batteryPower is presence, batteryStatus is normal/low, not a percentage.
    const cases = [
        {state: {pim: 1, batteryPower: 0, batteryStatus: 0}, low: 0},
        {state: {pim: 1, batteryPower: 1, batteryStatus: 0}, low: 0},
        {state: {pim: 1, batteryPower: 1, batteryStatus: 1}, low: 0},
        {state: {pim: 2, batteryPower: 1, batteryStatus: 1}, low: 0},
        {state: {pim: 2, batteryPower: 1, batteryStatus: 0}, low: 1},
        {state: {pim: 0, batteryPower: 0, batteryStatus: 0}, low: 0},
    ];
    for (const ignore of [false, true]) {
        device.config.set('ignore_battery_when_charging', ignore);
        for (const {state, low} of cases) {
            const reply = deviceReply('D4');
            Object.assign(reply.result.state, state);
            platform.http_getDeviceInfo = async () => reply;
            await new Promise(resolve => platform.http_getDeviceDetailStatus(device, resolve));
            assert.strictEqual(device.status.pim, state.pim);
            platform.uploadStatusToHomebridge(device);
            const battery = device.services.battery_status_service;
            assert.strictEqual(battery.getCharacteristic(Characteristic.StatusLowBattery).value, low);
            assert.strictEqual(battery.getCharacteristic(Characteristic.ChargingState).value, Characteristic.ChargingState.NOT_CHARGEABLE);
            assert.strictEqual(battery.testCharacteristic(Characteristic.BatteryLevel), false);
            platform.hb_deviceStatusLowBattery_get(device, (error, value) => { assert.ifError(error); assert.strictEqual(value, low); });
            platform.hb_deviceChargingState_get(device, (error, value) => { assert.ifError(error); assert.strictEqual(value, Characteristic.ChargingState.NOT_CHARGEABLE); });
        }
    }
});

test('cached Solo battery services discard the old fabricated percentage on restart', async () => {
    const platform = createPlatform();
    const device = await createDevice(platform, 'D4');
    const battery = device.services.battery_status_service;
    battery.setCharacteristic(Characteristic.BatteryLevel, 0);
    battery.setCharacteristic(Characteristic.StatusLowBattery, 1);
    const serviceCount = device.accessory.services.length;
    assert(platform.setupAccessory(device));
    assert.strictEqual(device.services.battery_status_service, battery);
    assert.strictEqual(device.accessory.services.length, serviceCount);
    assert.strictEqual(battery.testCharacteristic(Characteristic.BatteryLevel), false);
    assert.strictEqual(battery.getCharacteristic(Characteristic.StatusLowBattery).value, 0);
    platform.uploadStatusToHomebridge(device);
    assert.strictEqual(battery.testCharacteristic(Characteristic.BatteryLevel), false);
});

test('feeding callbacks acknowledge off and zero, and surface cloud failures', async () => {
    const platform = createPlatform();
    const device = await createDevice(platform, 'D4');
    const originalTimeout = global.setTimeout;
    global.setTimeout = () => {};
    try {
        let acknowledged = 0;
        platform.http_saveDailyFeed = async () => { throw new Error('Unexpected feeding'); };
        platform.hb_dropMeal_set(device, false, error => { assert.ifError(error); acknowledged++; });
        device.savedData.mealAmount = 0;
        platform.hb_dropMeal_set(device, true, error => { assert.ifError(error); acknowledged++; });
        assert.strictEqual(acknowledged, 2);
        device.savedData.mealAmount = 1;
        for (const [reply, success] of [[{result: {isExecuted: 1}}, true], [{error: {code: 1}}, false], [null, false]]) {
            platform.http_saveDailyFeed = async () => reply;
            const error = await new Promise(resolve => platform.hb_dropMeal_set(device, true, resolve));
            assert.strictEqual(!error, success);
        }
        assert.strictEqual(platform.praseSaveDailyFeedResult({result: null}), false);
    } finally {
        global.setTimeout = originalTimeout;
    }
});

test('settings login lists owned and shared Solo devices alongside Mini', async () => {
    for (const shared of [false, true]) {
        const ui = loadUiServer(async options => {
            const endpoint = new URL(options.url).pathname;
            if (endpoint.endsWith('/user/login')) return {data: {result: {session: {id: 'test-session'}}}};
            assert.strictEqual(options.headers['X-Session'], 'test-session');
            if (endpoint.endsWith('/group/family/list')) {
                return {data: {result: [{groupId: 'family', deviceList: shared ? [] : [
                    {deviceId: 'solo', deviceType: 'd4', deviceName: 'Solo'},
                    {deviceId: 'mini', deviceType: 'FeederMini', deviceName: 'Mini'},
                    {deviceId: 'other', deviceType: 'D4H'},
                ]}]}};
            }
            if (endpoint.endsWith('/discovery/device_roster_v2')) {
                return {data: {result: {devices: [{id: 'solo', type: 'd4'}, {id: 'mini', type: 'feedermini'}]}}};
            }
            assert(['/6/d4/device_detail', '/6/feedermini/device_detail'].includes(endpoint));
            return {data: {result: {name: endpoint.includes('/d4/') ? 'Solo' : 'Mini'}}};
        });
        const result = await ui.handlers.get('/test-login')({region: 'CN', username: 'test-user', password: 'test-password'});
        assert.deepStrictEqual(JSON.parse(JSON.stringify(result.devices)), [
            {id: 'solo', name: 'Solo', type: 'D4'}, {id: 'mini', name: 'Mini', type: 'FeederMini'},
        ]);
    }
});

async function main() {
    let currentTest;
    const timeout = setTimeout(() => {
        console.error('Timed out: ' + currentTest);
        process.exitCode = 1;
    }, 10000);
    try {
        for (const {name, run} of tests) {
            currentTest = name;
            await run();
            console.log('PASS ' + name);
        }
        console.log(tests.length + ' tests passed');
    } finally {
        clearTimeout(timeout);
    }
}

if (require.main === module) {
    main().catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = {createPlatform, loadUiServer, Service, Characteristic};
