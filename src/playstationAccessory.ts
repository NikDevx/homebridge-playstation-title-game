import {
    API,
    Characteristic,
    CharacteristicValue,
    PlatformAccessory,
    Service,
} from 'homebridge';
import path from 'path';

import {Device} from 'playactor/dist/device';
import {DeviceStatus, IDiscoveredDevice} from 'playactor/dist/discovery/model';

import {PlaystationPlatform} from './playstationPlatform';
import {PLUGIN_NAME} from './settings';
import {spawn} from 'child_process';

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout')), ms);
        promise.then((val) => {
            clearTimeout(timer);
            resolve(val);
        }).catch((err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

// All title lookups share one PSN session/token file, so they run one at a time
// (a single hung or slow lookup must not pile up concurrent python processes).
let globalFetchQueue: Promise<void> = Promise.resolve();

// A python lookup that takes longer than this is killed.
const TITLE_FETCH_TIMEOUT_MS = 45_000;
// Exit code of title_game.py meaning "PSN could not be queried reliably".
const EXIT_TRANSIENT_FAILURE = 3;
// After this many consecutive unreliable lookups we stop keeping the stale title.
const MAX_CONSECUTIVE_FAILURES = 5;

export class PlaystationAccessory {
    private readonly accessory: PlatformAccessory;
    private readonly tvService: Service;
    private readonly api: API = this.platform.api;
    private readonly Service: typeof Service = this.platform.Service;
    private readonly Characteristic: typeof Characteristic = this.platform.Characteristic;

    private lockUpdate = false;
    private lockSetOn = false;
    private tick: NodeJS.Timeout | undefined;
    private lockTimeout: NodeJS.Timeout | undefined;
    private lockUpdateTimeout: NodeJS.Timeout | undefined;
    private readonly kLockTimeout = 20_000;

    private titleIDs: string[] = [];
    private dynamicTitleSource: Service | null = null;
    private titleUpdateInterval: NodeJS.Timeout | null = null;
    private lastTitle: string | null = null;
    private fetchingTitle = false;
    private consecutiveFetchFailures = 0;

    constructor(
        private readonly platform: PlaystationPlatform,
        private deviceInformation: IDiscoveredDevice,
    ) {
        const uuid = this.api.hap.uuid.generate(deviceInformation.id);
        const override = this.platform.config.overrides?.find(
            (o) => o.deviceId === deviceInformation.id
        );

        const deviceConfig = this.platform.config.devices?.find(
            (d) => d.deviceId === deviceInformation.id
        );

        const deviceName = deviceConfig?.name || override?.name || this.platform.config.name || 'PlayStation';

        this.accessory = new this.api.platformAccessory(deviceName, uuid);
        this.accessory.category = this.api.hap.Categories.TV_SET_TOP_BOX;

        this.accessory.getService(this.Service.AccessoryInformation)!
            .setCharacteristic(this.Characteristic.Name, deviceName)
            .setCharacteristic(this.Characteristic.Manufacturer, 'Sony')
            .setCharacteristic(this.Characteristic.Model, deviceInformation.type)
            .setCharacteristic(this.Characteristic.SerialNumber, deviceInformation.id)
            .setCharacteristic(this.Characteristic.FirmwareRevision, deviceInformation.systemVersion);

        this.tvService =
            this.accessory.getService(this.Service.Television) ||
            this.accessory.addService(this.Service.Television);

        this.tvService.setCharacteristic(this.Characteristic.Name, deviceName);
        this.tvService.setCharacteristic(this.Characteristic.ConfiguredName, deviceName);

        this.tvService.getCharacteristic(this.Characteristic.ConfiguredName).updateValue(deviceName);
        this.tvService.getCharacteristic(this.Characteristic.Name).updateValue(deviceName);

        this.tvService.setCharacteristic(
            this.Characteristic.SleepDiscoveryMode,
            this.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE,
        );

        this.tvService.getCharacteristic(this.Characteristic.Active)
            .onSet(this.setOn.bind(this))
            .onGet(this.getOn.bind(this));

        this.tvService.getCharacteristic(this.Characteristic.RemoteKey)
            .onSet((newValue: CharacteristicValue) => {
                this.platform.log.debug(`[${this.deviceInformation.id}] RemoteKey not implemented`, newValue);
            });

        this.tvService.setCharacteristic(this.Characteristic.ActiveIdentifier, 0);

        this.addTitle('PSAXXXX', 'Loading', 0);
        this.startTitleUpdateLoop();
        this.updateGameTitleNow();

        this.tvService.getCharacteristic(this.Characteristic.ActiveIdentifier)
            .onSet(this.setTitleSwitchState.bind(this));

        let pollInterval = this.platform.config.pollInterval || 120000;
        const MAX_POLL_INTERVAL = 240000; // Hard limit 4 minutes (240,000 ms)

        if (pollInterval > MAX_POLL_INTERVAL) {
            this.platform.log.warn(
                `[${this.deviceInformation.id}] Poll Interval (${pollInterval}ms) is too high! ` +
                `Automatically reduced to ${MAX_POLL_INTERVAL}ms to keep the PSN session alive and prevent token expiration.`
            );
            pollInterval = MAX_POLL_INTERVAL;
        }

        this.tick = setInterval(
            this.updateDeviceInformations.bind(this),
            pollInterval,
        );

        this.api.publishExternalAccessories(PLUGIN_NAME, [this.accessory]);
    }

    private addTitle(titleId: string, titleName: string, index: number) {
        const titleInputSource = new this.Service.InputSource(titleName, titleId);
        titleInputSource
            .setCharacteristic(this.Characteristic.Identifier, index)
            .setCharacteristic(this.Characteristic.Name, titleName)
            .setCharacteristic(this.Characteristic.ConfiguredName, titleName)
            .setCharacteristic(this.Characteristic.IsConfigured, this.Characteristic.IsConfigured.NOT_CONFIGURED)
            .setCharacteristic(this.Characteristic.InputSourceType, this.Characteristic.InputSourceType.APPLICATION)
            .setCharacteristic(this.Characteristic.CurrentVisibilityState, this.Characteristic.CurrentVisibilityState.HIDDEN);

        this.accessory.addService(titleInputSource);
        this.tvService.addLinkedService(titleInputSource);
        this.titleIDs.push(titleId);
        this.dynamicTitleSource = titleInputSource;
    }

    private startTitleUpdateLoop() {
        let polling = this.platform.config.pollInterval || 120000;
        const MAX_POLL_INTERVAL = 240000; // Hard limit 4 minutes (240,000 ms)

        if (polling > MAX_POLL_INTERVAL) {
            polling = MAX_POLL_INTERVAL;
        }

        if (this.titleUpdateInterval) clearInterval(this.titleUpdateInterval);

        this.titleUpdateInterval = setInterval(() => {
            this.fetchAndSetTitle();
        }, polling);
    }

    private updateGameTitleNow() {
        this.fetchAndSetTitle();
    }

    private getAccountIds(): string[] {
        const device = this.platform.config.devices?.find(
            (d) => d.deviceId === this.deviceInformation.id
        );
        const accounts = device?.account_id?.length ? device.account_id : this.platform.config.account_id;
        return (accounts || []).map((acc) => acc.id);
    }

    private fetchAndSetTitle() {
        // Skip if the previous lookup for this console is still queued/running.
        if (this.fetchingTitle) return;
        this.fetchingTitle = true;

        globalFetchQueue = globalFetchQueue
            .then(() => this.runTitleFetch())
            .catch((err) => {
                this.platform.log.debug(`Title fetch failed: ${(err as Error).message}`);
            })
            .then(() => {
                this.fetchingTitle = false;
            });
    }

    private runTitleFetch(): Promise<void> {
        return new Promise((resolve) => {
            const PSNAWP = this.platform.config.PSNAWP || '';
            const account_ids = this.getAccountIds();
            const scriptPath = path.join(__dirname, 'title_game.py');
            const dataFilePath = path.join(this.platform.api.user.storagePath(), 'homebridge_psn_data.json');
            const get_title = spawn('python3', [scriptPath, PSNAWP, JSON.stringify(account_ids), dataFilePath]);

            let output = '';
            let finished = false;

            const finish = () => {
                if (finished) return false;
                finished = true;
                clearTimeout(watchdog);
                get_title.removeAllListeners();
                resolve();
                return true;
            };

            const watchdog = setTimeout(() => {
                this.platform.log.debug(`Python title lookup timed out after ${TITLE_FETCH_TIMEOUT_MS}ms - killing it`);
                get_title.kill('SIGKILL');
                if (finish()) this.handleFetchFailure();
            }, TITLE_FETCH_TIMEOUT_MS);

            get_title.stdout.on('data', (data) => {
                output += data.toString();
            });

            get_title.on('close', (code) => {
                if (finished) return;
                finish();

                if (code === EXIT_TRANSIENT_FAILURE) {
                    this.handleFetchFailure();
                    return;
                }

                if (code !== 0) {
                    this.platform.log.debug(`Python script exited with code ${code}`);
                    return;
                }

                const newTitle = output.trim();
                if (!newTitle || newTitle.length === 0) return;

                if (
                    newTitle.toLowerCase().includes('error') ||
                    newTitle.includes('{') ||
                    newTitle.includes('database is locked') ||
                    newTitle.includes('temporarily_unavailable')
                ) {
                    this.platform.log.debug(`🔇 Ignored bad title output: ${newTitle}`);
                    return;
                }

                this.consecutiveFetchFailures = 0;
                this.applyTitle(newTitle);
            });

            get_title.on('error', (err) => {
                this.platform.log.error(`Failed to start python script: ${err.message}`);
                finish();
            });
        });
    }

    /**
     * A lookup failed for a transient reason (network/PSN API). Keep showing the
     * last known title instead of "Offline"; only after several failures in a
     * row do we fall back to "Offline" so a permanently broken setup is visible.
     */
    private handleFetchFailure() {
        this.consecutiveFetchFailures++;
        this.platform.log.debug(
            `PSN lookup unreliable (${this.consecutiveFetchFailures}/${MAX_CONSECUTIVE_FAILURES}) - keeping "${this.lastTitle}"`
        );
        if (this.consecutiveFetchFailures >= MAX_CONSECUTIVE_FAILURES) {
            this.applyTitle('Offline');
        }
    }

    private applyTitle(newTitle: string) {
        if (newTitle === this.lastTitle || !this.dynamicTitleSource) return;

        this.lastTitle = newTitle;
        this.platform.log.info(`🎮 PSN Title Updated: ${newTitle}`);

        const safeTitle = newTitle.substring(0, 63);

        this.dynamicTitleSource
            .setCharacteristic(this.Characteristic.Name, safeTitle)
            .setCharacteristic(this.Characteristic.ConfiguredName, safeTitle);
    }

    private runCustomCommand(command: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const child = spawn(command, { shell: true });

            let stderr = '';
            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('close', (code) => {
                child.removeAllListeners();
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Command exited with code ${code}: ${stderr.trim()}`));
                }
            });

            child.on('error', (err) => {
                child.removeAllListeners();
                reject(err);
            });
        });
    }

    private async discoverDevice() {
        const device = Device.withId(this.deviceInformation.id);
        this.deviceInformation = await device.discover();
        return device;
    }

    private async getOn(): Promise<CharacteristicValue> {
        return this.deviceInformation.status === DeviceStatus.AWAKE;
    }

    private setOn(value: CharacteristicValue): void {
        if (this.lockSetOn) {
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.RESOURCE_BUSY);
        }

        this.addLocks();

        this.tvService
            .getCharacteristic(this.Characteristic.Active)
            .updateValue(value);

        void (async () => {
            let commandSuccess = false;
            try {
                const cmdOn = (this.platform.config.cmdOn || '').trim();
                const cmdOff = (this.platform.config.cmdOff || '').trim();

                if (value) {
                    if (cmdOn) {
                        this.platform.log.info(`[${this.deviceInformation.id}] 🆙 Executing Custom ON Command...`);
                        await timeout(this.runCustomCommand(cmdOn), 15_000);
                    } else {
                        const device = await this.discoverDevice();
                        const connection = await device.openConnection();
                        this.platform.log.debug(`[${this.deviceInformation.id}] 🆙 Waking device via PlayActor...`);
                        await timeout(device.wake(), 15_000);
                        await connection.close();
                    }
                } else {
                    if (cmdOff) {
                        this.platform.log.info(`[${this.deviceInformation.id}] 💤 Executing Custom OFF Command...`);
                        await timeout(this.runCustomCommand(cmdOff), 15_000);
                    } else {
                        const device = await this.discoverDevice();
                        const connection = await device.openConnection();
                        this.platform.log.info(`[${this.deviceInformation.id}] 💤 Sending standby command via PlayActor...`);
                        await timeout(connection.standby(), 15_000);
                        await connection.close();
                    }
                }

                commandSuccess = true;

                // Примусово зафіксуємо новий статус локально та у HomeKit
                this.deviceInformation.status = value ? DeviceStatus.AWAKE : DeviceStatus.STANDBY;
                this.tvService
                    .getCharacteristic(this.Characteristic.Active)
                    .updateValue(value);

            } catch (err) {
                const message = (err as Error).message;

                if (!value && message.includes('403') && message.includes('Remote is already in use')) {
                    this.platform.log.warn(`[${this.deviceInformation.id}] Remote already in use — assuming console already in standby.`);
                    this.deviceInformation.status = DeviceStatus.STANDBY;
                    this.tvService
                        .getCharacteristic(this.Characteristic.Active)
                        .updateValue(false);
                    return;
                }

                this.platform.log.error(`[${this.deviceInformation.id}] Power Control Error: ${message}`);
            } finally {
                if (commandSuccess) {
                    // У разі успіху заморожуємо фонове опитування на 20 сек, поки PS5 стартує/вимикається
                    this.releaseLocks(20_000);
                } else {
                    this.releaseLocks(0);
                    await this.updateDeviceInformations(true);
                }
            }
        })();
    }

    private async setTitleSwitchState(value: CharacteristicValue) {
        const requestedTitle = this.titleIDs[value as number] || null;
        if (!requestedTitle) return;

        if (this.lockSetOn) {
            throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.RESOURCE_BUSY);
        }

        this.addLocks();

        try {
            if (this.deviceInformation.status !== DeviceStatus.AWAKE) {
                this.platform.log.warn(`[${this.deviceInformation.id}] Console not awake. Cannot start title.`);
                return;
            }

            const device = await this.discoverDevice();

            if (this.deviceInformation.extras['running-app-titleid'] === requestedTitle) return;

            const connection = await device.openConnection();
            await connection.startTitleId?.(requestedTitle);
            await connection.close();
        } catch (err) {
            this.platform.log.error((err as Error).message);
        } finally {
            this.releaseLocks(0);
        }
    }

    private async updateDeviceInformations(force = false) {
        if (this.lockUpdate && !force) return;

        this.lockUpdate = true;

        try {
            await this.discoverDevice();
        } catch {
            this.deviceInformation.status = DeviceStatus.STANDBY;
        } finally {
            this.lockUpdate = false;
            this.tvService
                .getCharacteristic(this.platform.Characteristic.Active)
                .updateValue(this.deviceInformation.status === DeviceStatus.AWAKE);
        }
    }

    private addLocks() {
        this.lockSetOn = true;
        this.lockUpdate = true;
        if (this.lockTimeout) clearTimeout(this.lockTimeout);
        if (this.lockUpdateTimeout) clearTimeout(this.lockUpdateTimeout);

        this.lockTimeout = setTimeout(() => {
            this.lockSetOn = false;
        }, this.kLockTimeout);
    }

    private releaseLocks(holdUpdateLockMs = 0) {
        this.lockSetOn = false;
        if (this.lockTimeout) clearTimeout(this.lockTimeout);

        if (holdUpdateLockMs > 0) {
            this.lockUpdate = true;
            if (this.lockUpdateTimeout) clearTimeout(this.lockUpdateTimeout);
            this.lockUpdateTimeout = setTimeout(() => {
                this.lockUpdate = false;
            }, holdUpdateLockMs);
        } else {
            this.lockUpdate = false;
            if (this.lockUpdateTimeout) clearTimeout(this.lockUpdateTimeout);
        }
    }
}