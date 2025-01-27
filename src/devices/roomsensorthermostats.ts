import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { interval, Subject } from 'rxjs';
import superStringify from 'super-stringify';
import { debounceTime, skipWhile, take, tap } from 'rxjs/operators';
import { ResideoPlatform } from '../platform';
import * as settings from '../settings';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class RoomSensorThermostat {
  // Services
  service: Service;

  // CharacteristicValue
  TargetTemperature!: CharacteristicValue;
  CurrentTemperature!: CharacteristicValue;
  CurrentRelativeHumidity!: CharacteristicValue;
  TemperatureDisplayUnits!: CharacteristicValue;
  TargetHeatingCoolingState!: CharacteristicValue;
  CurrentHeatingCoolingState!: CharacteristicValue;
  CoolingThresholdTemperature!: CharacteristicValue;
  HeatingThresholdTemperature!: CharacteristicValue;

  // Others
  modes: settings.modes;
  action!: string;
  roompriority: any;
  resideoMode!: Array<string>;
  deviceFan!: settings.FanChangeableValues;

  // Config
  deviceLogging!: string;
  deviceRefreshRate!: number;

  // Thermostat Update
  thermostatUpdateInProgress!: boolean;
  doThermostatUpdate!: Subject<void>;

  // Room Updates
  roomUpdateInProgress!: boolean;
  doRoomUpdate!: Subject<void>;

  // Fan Updates
  fanUpdateInProgress!: boolean;
  doFanUpdate!: Subject<void>;

  constructor(
    private readonly platform: ResideoPlatform,
    private accessory: PlatformAccessory,
    public readonly locationId: settings.location['locationID'],
    public device: settings.device & settings.devicesConfig,
    public sensorAccessory: settings.sensorAccessory,
    public readonly group: settings.T9groups,
  ) {
    this.logs(device);
    this.refreshRate(device);
    this.config(device);
    // Map Resideo Modes to HomeKit Modes
    this.modes = {
      Off: platform.Characteristic.TargetHeatingCoolingState.OFF,
      Heat: platform.Characteristic.TargetHeatingCoolingState.HEAT,
      Cool: platform.Characteristic.TargetHeatingCoolingState.COOL,
      Auto: platform.Characteristic.TargetHeatingCoolingState.AUTO,
    };

    // Map HomeKit Modes to Resideo Modes
    // Don't change the order of these!
    this.resideoMode = ['Off', 'Heat', 'Cool', 'Auto'];

    // default placeholders
    this.CurrentTemperature;
    this.TargetTemperature;
    this.CurrentHeatingCoolingState;
    this.TargetHeatingCoolingState;
    this.CoolingThresholdTemperature;
    this.HeatingThresholdTemperature;
    this.CurrentRelativeHumidity;
    this.TemperatureDisplayUnits;

    // this is subject we use to track when we need to POST changes to the Resideo API
    this.doRoomUpdate = new Subject();
    this.roomUpdateInProgress = false;
    this.doThermostatUpdate = new Subject();
    this.thermostatUpdateInProgress = false;

    // set accessory information
    accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Resideo')
      .setCharacteristic(this.platform.Characteristic.Model, sensorAccessory.accessoryAttribute.model || '1100')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, sensorAccessory.deviceID)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, accessory.context.firmwareRevision)
      .getCharacteristic(this.platform.Characteristic.FirmwareRevision)
      .updateValue(accessory.context.firmwareRevision);

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    (this.service = this.accessory.getService(this.platform.Service.Thermostat) || this.accessory.addService(this.platform.Service.Thermostat)),
    `${accessory.displayName} Thermostat`;

    // To avoid "Cannot add a Service with the same UUID another Service without also defining a unique 'subtype' property." error,
    // when creating multiple services of the same type, you need to use the following syntax to specify a name and subtype id:
    // this.accessory.getService('NAME') ?? this.accessory.addService(this.platform.Service.Lightbulb, 'NAME', 'USER_DEFINED_SUBTYPE');

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, `${accessory.displayName} Thermostat`);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Thermostat

    // Do initial device parse
    this.parseStatus();

    // Set Min and Max
    if (device.changeableValues!.heatCoolMode === 'Heat') {
      this.debugLog(`Room Sensor Thermostat: ${accessory.displayName} mode: ${device.changeableValues!.heatCoolMode}`);
      this.service
        .getCharacteristic(this.platform.Characteristic.TargetTemperature)
        .setProps({
          minValue: this.toCelsius(device.minHeatSetpoint!),
          maxValue: this.toCelsius(device.maxHeatSetpoint!),
          minStep: 0.5,
        })
        .onGet(() => {
          return this.TargetTemperature;
        });
    } else {
      this.debugLog(`Room Sensor Thermostat: ${accessory.displayName} mode: ${device.changeableValues!.heatCoolMode}`);
      this.service
        .getCharacteristic(this.platform.Characteristic.TargetTemperature)
        .setProps({
          minValue: this.toCelsius(device.minCoolSetpoint!),
          maxValue: this.toCelsius(device.maxCoolSetpoint!),
          minStep: 0.5,
        })
        .onGet(() => {
          return this.TargetTemperature;
        });
    }

    // The value property of TargetHeaterCoolerState must be one of the following:
    //AUTO = 3; HEAT = 1; COOL = 2; OFF = 0;
    // Set control bindings
    const TargetState = this.TargetState();
    this.service
      .getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: TargetState,
      })
      .onSet(this.setTargetHeatingCoolingState.bind(this));

    this.service.setCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, this.CurrentHeatingCoolingState);

    this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature).onSet(this.setHeatingThresholdTemperature.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature).onSet(this.setCoolingThresholdTemperature.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature).onSet(this.setTargetTemperature.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits).onSet(this.setTemperatureDisplayUnits.bind(this));

    // Retrieve initial values and updateHomekit
    this.updateHomeKitCharacteristics();

    // Start an update interval
    interval(this.platform.config.options!.refreshRate! * 1000)
      .pipe(skipWhile(() => this.thermostatUpdateInProgress))
      .subscribe(async () => {
        await this.refreshStatus();
        await this.refreshSensorStatus();
      });

    // Watch for thermostat change events
    // We put in a debounce of 100ms so we don't make duplicate calls
    if (device.thermostat?.roompriority?.deviceType === 'Thermostat') {
      this.doRoomUpdate
        .pipe(
          tap(() => {
            this.roomUpdateInProgress = true;
          }),
          debounceTime(this.platform.config.options!.pushRate! * 500),
        )
        .subscribe(async () => {
          try {
            await this.refreshRoomPriority();
          } catch (e: any) {
            this.action = 'refreshRoomPriority';
            this.resideoAPIError(e);
            this.apiError(e);
          }
          try {
            await this.pushRoomChanges();
          } catch (e: any) {
            this.action = 'pushRoomChanges';
            this.resideoAPIError(e);
            this.apiError(e);
          }
          this.roomUpdateInProgress = false;
          // Refresh the status from the API
          interval(5000)
            .pipe(skipWhile(() => this.thermostatUpdateInProgress))
            .pipe(take(1))
            .subscribe(async () => {
              await this.refreshStatus();
            });
        });
    }
    this.doThermostatUpdate
      .pipe(
        tap(() => {
          this.thermostatUpdateInProgress = true;
        }),
        debounceTime(this.platform.config.options!.pushRate! * 1000),
      )
      .subscribe(async () => {
        try {
          await this.pushChanges();
        } catch (e: any) {
          this.action = 'pushChanges';
          this.resideoAPIError(e);
          this.apiError(e);
        }
        this.thermostatUpdateInProgress = false;
        // Refresh the status from the API
        interval(5000)
          .pipe(skipWhile(() => this.thermostatUpdateInProgress))
          .pipe(take(1))
          .subscribe(async () => {
            await this.refreshStatus();
          });
      });
  }

  /**
   * Parse the device status from the Resideo api
   */
  async parseStatus(): Promise<void> {
    if (this.device.units === 'Fahrenheit') {
      this.TemperatureDisplayUnits = this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
    }
    if (this.device.units === 'Celsius') {
      this.TemperatureDisplayUnits = this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
    }
    /*this.TemperatureDisplayUnits = this.device.units === 'Fahrenheit' ? this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT :
      this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;
    this.TemperatureDisplayUnits = this.device.units === 'Fahrenheit' ? this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT :
      this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS;*/

    this.CurrentTemperature = this.toCelsius(this.sensorAccessory.accessoryValue.indoorTemperature);
    this.CurrentRelativeHumidity = this.sensorAccessory.accessoryValue.indoorHumidity;

    if (this.device.changeableValues!.heatSetpoint > 0) {
      this.HeatingThresholdTemperature = this.toCelsius(this.device.changeableValues!.heatSetpoint);
    }

    if (this.device.changeableValues!.coolSetpoint > 0) {
      this.CoolingThresholdTemperature = this.toCelsius(this.device.changeableValues!.coolSetpoint);
    }

    this.TargetHeatingCoolingState = this.modes[this.device.changeableValues!.mode];

    /**
     * The CurrentHeatingCoolingState is either 'Heat', 'Cool', or 'Off'
     * CurrentHeatingCoolingState =  OFF = 0, HEAT = 1, COOL = 2
     */
    switch (this.device.operationStatus!.mode) {
      case 'Heat':
        this.CurrentHeatingCoolingState = 1;
        break;
      case 'Cool':
        this.CurrentHeatingCoolingState = 2;
        break;
      default:
        this.CurrentHeatingCoolingState = 0;
    }
    this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} CurrentHeatingCoolingState: ${this.CurrentHeatingCoolingState}`);

    // Set the TargetTemperature value based on the current mode
    if (this.TargetHeatingCoolingState === this.platform.Characteristic.TargetHeatingCoolingState.HEAT) {
      if (this.device.changeableValues!.heatSetpoint > 0) {
        this.TargetTemperature = this.toCelsius(this.device.changeableValues!.heatSetpoint);
      }
    } else {
      if (this.device.changeableValues!.coolSetpoint > 0) {
        this.TargetTemperature = this.toCelsius(this.device.changeableValues!.coolSetpoint);
      }
    }
  }

  /**
   * Asks the Resideo Home API for the latest device information
   */
  async refreshStatus(): Promise<void> {
    try {
      const device: any = (
        await this.platform.axios.get(`${settings.DeviceURL}/thermostats/${this.device.deviceID}`, {
          params: {
            locationId: this.locationId,
          },
        })
      ).data;
      this.device = device;
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} device: ${superStringify(device)}`);
      this.debugLog(
        `Room Sensor Thermostat: ${this.accessory.displayName}` +
          ` Fetched update for: ${this.device.name} from Resideo API: ${superStringify(this.device.changeableValues)}`,
      );

      this.parseStatus();
      this.updateHomeKitCharacteristics();
    } catch (e: any) {
      this.action = 'refreshStatus';
      this.resideoAPIError(e);
      this.apiError(e);
    }
  }

  /**
   * Asks the Resideo Home API for the latest device information
   */
  async refreshSensorStatus(): Promise<void> {
    try {
      if (this.device.thermostat?.roompriority?.deviceType === 'Thermostat') {
        if (this.device.deviceID.startsWith('LCC')) {
          if (this.device.deviceModel.startsWith('T9')) {
            if (this.device.groups) {
              const groups = this.device.groups;
              for (const group of groups) {
                const roomsensors = await this.platform.getCurrentSensorData(this.device, group, this.locationId);
                if (roomsensors.rooms) {
                  const rooms = roomsensors.rooms;
                  this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} roomsensors: ${superStringify(roomsensors)}`);
                  for (const accessories of rooms) {
                    if (accessories) {
                      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} accessories: ${superStringify(accessories)}`);
                      for (const accessory of accessories.accessories) {
                        if (accessory.accessoryAttribute) {
                          if (accessory.accessoryAttribute.type) {
                            if (accessory.accessoryAttribute.type.startsWith('IndoorAirSensor')) {
                              this.sensorAccessory = accessory;
                              this.debugLog(
                                `Room Sensor Thermostat: ${this.accessory.displayName}` +
                                  ` accessoryAttribute: ${superStringify(this.sensorAccessory.accessoryAttribute)}`,
                              );
                              this.debugLog(
                                `Room Sensor Thermostat: ${this.accessory.displayName}` +
                                  ` Name: ${this.sensorAccessory.accessoryAttribute.name},` +
                                  ` Software Version: ${this.sensorAccessory.accessoryAttribute.softwareRevision}`,
                              );
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      this.parseStatus();
      this.updateHomeKitCharacteristics();
    } catch (e: any) {
      this.action = 'refreshSensorStatus';
      this.resideoAPIError(e);
      this.apiError(e);
    }
  }

  async refreshRoomPriority(): Promise<void> {
    if (this.device.thermostat?.roompriority?.deviceType === 'Thermostat') {
      this.roompriority = (
        await this.platform.axios.get(`${settings.DeviceURL}/thermostats/${this.device.deviceID}/priority`, {
          params: {
            locationId: this.locationId,
          },
        })
      ).data;
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} roompriority: ${superStringify(this.roompriority)}`);
    }
  }

  /**
   * Pushes the requested changes for Room Priority to the Resideo API
   */
  async pushRoomChanges(): Promise<void> {
    this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} Room Priority,
     Current Room: ${superStringify(this.roompriority.currentPriority.selectedRooms)}, Changing Room: [${this.sensorAccessory.accessoryId}]`);
    if (`[${this.sensorAccessory.accessoryId}]` !== `[${this.roompriority.currentPriority.selectedRooms}]`) {
      const payload = {
        currentPriority: {
          priorityType: this.device.thermostat?.roompriority?.priorityType,
        },
      } as any;

      if (this.device.thermostat?.roompriority?.priorityType === 'PickARoom') {
        payload.currentPriority.selectedRooms = [this.sensorAccessory.accessoryId];
      }

      /**
       * For "LCC-" devices only.
       * "NoHold" will return to schedule.
       * "TemporaryHold" will hold the set temperature until "nextPeriodTime".
       * "PermanentHold" will hold the setpoint until user requests another change.
       */
      if (this.device.thermostat?.roompriority?.deviceType === 'Thermostat') {
        if (this.device.thermostat?.roompriority.priorityType === 'FollowMe') {
          this.platform.log.info(
            `Room Sensor Thermostat: ${this.accessory.displayName} sent request to Resideo API, Priority Type: ` +
              `${this.device.thermostat?.roompriority.priorityType} Built-in Occupancy Sensor(s) Will be used to set Priority Automatically.`,
          );
        } else if (this.device.thermostat?.roompriority.priorityType === 'WholeHouse') {
          this.platform.log.info(
            `Room Sensor Thermostat: ${this.accessory.displayName} sent request to Resideo API,` +
              ` Priority Type: ${this.device.thermostat?.roompriority.priorityType}`,
          );
        } else if (this.device.thermostat?.roompriority.priorityType === 'PickARoom') {
          this.platform.log.info(
            `Room Sensor Thermostat: ${this.accessory.displayName} sent request to Resideo API,` +
              ` Room Priority: ${this.sensorAccessory.accessoryAttribute.name}, Priority Type: ${this.device.thermostat?.roompriority.priorityType}`,
          );
        }

        // Make the API request
        await this.platform.axios.put(`${settings.DeviceURL}/thermostats/${this.device.deviceID}/priority`, payload, {
          params: {
            locationId: this.locationId,
          },
        });
        this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} pushRoomChanges: ${superStringify(payload)}`);
      }
      // Refresh the status from the API
      await this.refreshSensorStatus();
    }
  }

  /**
   * Pushes the requested changes to the Resideo API
   */
  async pushChanges(): Promise<void> {
    try {
      const payload = {
        mode: this.resideoMode[Number(this.TargetHeatingCoolingState)],
        thermostatSetpointStatus: this.device.thermostat?.thermostatSetpointStatus,
        autoChangeoverActive: this.device.changeableValues!.autoChangeoverActive,
      } as settings.payload;

      // Set the heat and cool set point value based on the selected mode
      switch (this.TargetHeatingCoolingState) {
        case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
          payload.heatSetpoint = this.toFahrenheit(Number(this.TargetTemperature));
          payload.coolSetpoint = this.toFahrenheit(Number(this.CoolingThresholdTemperature));
          this.debugLog(
            `Room Sensor Thermostat: ${this.accessory.displayName}` +
              ` TargetHeatingCoolingState (HEAT): ${this.TargetHeatingCoolingState},` +
              ` TargetTemperature: ${this.toFahrenheit(Number(this.TargetTemperature))} heatSetpoint,` +
              ` CoolingThresholdTemperature: ${this.toFahrenheit(Number(this.CoolingThresholdTemperature))} coolSetpoint`,
          );
          break;
        case this.platform.Characteristic.TargetHeatingCoolingState.COOL:
          payload.coolSetpoint = this.toFahrenheit(Number(this.TargetTemperature));
          payload.heatSetpoint = this.toFahrenheit(Number(this.HeatingThresholdTemperature));
          this.debugLog(
            `Room Sensor Thermostat: ${this.accessory.displayName}` +
              ` TargetHeatingCoolingState (COOL): ${this.TargetHeatingCoolingState},` +
              ` TargetTemperature: ${this.toFahrenheit(Number(this.TargetTemperature))} coolSetpoint,` +
              ` CoolingThresholdTemperature: ${this.toFahrenheit(Number(this.HeatingThresholdTemperature))} heatSetpoint`,
          );
          break;
        case this.platform.Characteristic.TargetHeatingCoolingState.AUTO:
          payload.coolSetpoint = this.toFahrenheit(Number(this.CoolingThresholdTemperature));
          payload.heatSetpoint = this.toFahrenheit(Number(this.HeatingThresholdTemperature));
          this.debugLog(
            `Room Sensor Thermostat: ${this.accessory.displayName}` +
              ` TargetHeatingCoolingState (AUTO): ${this.TargetHeatingCoolingState},` +
              ` CoolingThresholdTemperature: ${this.toFahrenheit(Number(this.CoolingThresholdTemperature))} coolSetpoint,` +
              ` HeatingThresholdTemperature: ${this.toFahrenheit(Number(this.HeatingThresholdTemperature))} heatSetpoint`,
          );
          break;
        default:
          payload.coolSetpoint = this.toFahrenheit(Number(this.CoolingThresholdTemperature));
          payload.heatSetpoint = this.toFahrenheit(Number(this.HeatingThresholdTemperature));
          this.debugLog(
            `Room Sensor Thermostat: ${this.accessory.displayName}` +
              ` TargetHeatingCoolingState (OFF): ${this.TargetHeatingCoolingState},` +
              ` CoolingThresholdTemperature: ${this.toFahrenheit(Number(this.CoolingThresholdTemperature))} coolSetpoint,` +
              ` HeatingThresholdTemperature: ${this.toFahrenheit(Number(this.HeatingThresholdTemperature))} heatSetpoint`,
          );
      }
      this.platform.log.info(`Room Sensor Thermostat: ${this.accessory.displayName} set request (${superStringify(payload)}) to Resideo API.`);

      // Make the API request
      await this.platform.axios.post(`${settings.DeviceURL}/thermostats/${this.device.deviceID}`, payload, {
        params: {
          locationId: this.locationId,
        },
      });
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} pushChanges: ${superStringify(payload)}`);
    } catch (e: any) {
      this.action = 'pushChanges';
      this.resideoAPIError(e);
      this.apiError(e);
    }
  }

  /**
   * Updates the status for each of the HomeKit Characteristics
   */
  async updateHomeKitCharacteristics(): Promise<void> {
    if (this.TemperatureDisplayUnits === undefined) {
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} TemperatureDisplayUnits: ${this.TemperatureDisplayUnits}`);
    } else {
      this.service.updateCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits, this.TemperatureDisplayUnits);
      this.debugLog(
        `Room Sensor Thermostat: ${this.accessory.displayName}` + ` updateCharacteristic TemperatureDisplayUnits: ${this.TemperatureDisplayUnits}`,
      );
    }
    if (this.CurrentTemperature === undefined) {
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} CurrentTemperature: ${this.CurrentTemperature}`);
    } else {
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.CurrentTemperature);
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName}` + ` updateCharacteristic CurrentTemperature: ${this.CurrentTemperature}`);
    }
    if (this.CurrentRelativeHumidity === undefined) {
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} CurrentRelativeHumidity: ${this.CurrentRelativeHumidity}`);
    } else {
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, this.CurrentRelativeHumidity);
      this.debugLog(
        `Room Sensor Thermostat: ${this.accessory.displayName}` + ` updateCharacteristic CurrentRelativeHumidity: ${this.CurrentRelativeHumidity}`,
      );
    }
    if (this.TargetTemperature === undefined) {
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} TargetTemperature: ${this.TargetTemperature}`);
    } else {
      this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.TargetTemperature);
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} updateCharacteristic TargetTemperature: ${this.TargetTemperature}`);
    }
    if (this.HeatingThresholdTemperature === undefined) {
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} HeatingThresholdTemperature: ${this.HeatingThresholdTemperature}`);
    } else {
      this.service.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, this.HeatingThresholdTemperature);
      this.debugLog(
        `Room Sensor Thermostat: ${this.accessory.displayName} updateCharacteristic` +
          ` HeatingThresholdTemperature: ${this.HeatingThresholdTemperature}`,
      );
    }
    if (this.CoolingThresholdTemperature === undefined) {
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} CoolingThresholdTemperature: ${this.CoolingThresholdTemperature}`);
    } else {
      this.service.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, this.CoolingThresholdTemperature);
      this.debugLog(
        `Room Sensor Thermostat: ${this.accessory.displayName} updateCharacteristic` +
          ` CoolingThresholdTemperature: ${this.CoolingThresholdTemperature}`,
      );
    }
    if (this.TargetHeatingCoolingState === undefined) {
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} TargetHeatingCoolingState: ${this.TargetHeatingCoolingState}`);
    } else {
      this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, this.TargetHeatingCoolingState);
      this.debugLog(
        `Room Sensor Thermostat: ${this.accessory.displayName} updateCharacteristic` +
          ` TargetHeatingCoolingState: ${this.TargetHeatingCoolingState}`,
      );
    }
    if (this.CurrentHeatingCoolingState === undefined) {
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} CurrentHeatingCoolingState: ${this.CurrentHeatingCoolingState}`);
    } else {
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, this.CurrentHeatingCoolingState);
      this.debugLog(
        `Room Sensor Thermostat: ${this.accessory.displayName} updateCharacteristic` +
          ` CurrentHeatingCoolingState: ${this.TargetHeatingCoolingState}`,
      );
    }
  }

  async apiError(e: any): Promise<void> {
    this.service.updateCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits, e);
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, e);
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, e);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, e);
    this.service.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, e);
    this.service.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, e);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, e);
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState, e);
    //throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  async resideoAPIError(e: any): Promise<void> {
    if (this.device.retry) {
      if (this.action === 'pushChanges') {
        // Refresh the status from the API
        interval(5000)
          .pipe(skipWhile(() => this.thermostatUpdateInProgress))
          .pipe(take(1))
          .subscribe(async () => {
            await this.pushChanges();
          });
      } else if (this.action === 'refreshRoomPriority') {
        // Refresh the status from the API
        interval(5000)
          .pipe(skipWhile(() => this.thermostatUpdateInProgress))
          .pipe(take(1))
          .subscribe(async () => {
            await this.refreshRoomPriority();
          });
      } else if (this.action === 'pushRoomChanges') {
        // Refresh the status from the API
        interval(5000)
          .pipe(skipWhile(() => this.thermostatUpdateInProgress))
          .pipe(take(1))
          .subscribe(async () => {
            await this.pushRoomChanges();
          });
      } else if (this.action === 'refreshStatus') {
        // Refresh the status from the API
        interval(5000)
          .pipe(skipWhile(() => this.thermostatUpdateInProgress))
          .pipe(take(1))
          .subscribe(async () => {
            await this.refreshStatus();
          });
      }
    }
    if (e.message.includes('400')) {
      this.platform.log.error(`Room Sensor Thermostat: ${this.accessory.displayName} failed to ${this.action}, Bad Request`);
      this.debugLog('The client has issued an invalid request. This is commonly used to specify validation errors in a request payload.');
    } else if (e.message.includes('401')) {
      this.platform.log.error(`Room Sensor Thermostat: ${this.accessory.displayName} failed to ${this.action}, Unauthorized Request`);
      this.debugLog('Authorization for the API is required, but the request has not been authenticated.');
    } else if (e.message.includes('403')) {
      this.platform.log.error(`Room Sensor Thermostat: ${this.accessory.displayName} failed to ${this.action}, Forbidden Request`);
      this.debugLog('The request has been authenticated but does not have appropriate permissions, or a requested resource is not found.');
    } else if (e.message.includes('404')) {
      this.platform.log.error(`Room Sensor Thermostat: ${this.accessory.displayName} failed to ${this.action}, Requst Not Found`);
      this.debugLog('Specifies the requested path does not exist.');
    } else if (e.message.includes('406')) {
      this.platform.log.error(`Room Sensor Thermostat: ${this.accessory.displayName} failed to ${this.action}, Request Not Acceptable`);
      this.debugLog('The client has requested a MIME type via the Accept header for a value not supported by the server.');
    } else if (e.message.includes('415')) {
      this.platform.log.error(`Room Sensor Thermostat: ${this.accessory.displayName} failed to ${this.action}, Unsupported Requst Header`);
      this.debugLog('The client has defined a contentType header that is not supported by the server.');
    } else if (e.message.includes('422')) {
      this.platform.log.error(`Room Sensor Thermostat: ${this.accessory.displayName} failed to ${this.action}, Unprocessable Entity`);
      this.debugLog(
        'The client has made a valid request, but the server cannot process it.' +
          ' This is often used for APIs for which certain limits have been exceeded.',
      );
    } else if (e.message.includes('429')) {
      this.platform.log.error(`Room Sensor Thermostat: ${this.accessory.displayName} failed to ${this.action}, Too Many Requests`);
      this.debugLog('The client has exceeded the number of requests allowed for a given time window.');
    } else if (e.message.includes('500')) {
      this.platform.log.error(`Room Sensor Thermostat: ${this.accessory.displayName} failed to ${this.action}, Internal Server Error`);
      this.debugLog('An unexpected error on the SmartThings servers has occurred. These errors should be rare.');
    } else {
      this.platform.log.error(`Room Sensor Thermostat: ${this.accessory.displayName} failed to ${this.action},`);
    }
    if (this.deviceLogging.includes('debug')) {
      this.platform.log.error(
        `Room Sensor Thermostat: ${this.accessory.displayName} failed to pushChanges, ` + `Error Message: ${superStringify(e.message)}`,
      );
    }
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} Set TargetHeatingCoolingState: ${value}`);

    this.TargetHeatingCoolingState = value;

    // Set the TargetTemperature value based on the selected mode
    if (this.TargetHeatingCoolingState === this.platform.Characteristic.TargetHeatingCoolingState.HEAT) {
      this.TargetTemperature = this.toCelsius(this.device.changeableValues!.heatSetpoint);
    } else {
      this.TargetTemperature = this.toCelsius(this.device.changeableValues!.coolSetpoint);
    }
    this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.TargetTemperature);
    if (this.TargetHeatingCoolingState !== this.modes[this.device.changeableValues!.mode]) {
      this.doRoomUpdate.next();
      this.doThermostatUpdate.next();
    }
  }

  async setHeatingThresholdTemperature(value: CharacteristicValue): Promise<void> {
    this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} Set HeatingThresholdTemperature: ${value}`);
    this.HeatingThresholdTemperature = value;
    this.doThermostatUpdate.next();
  }

  async setCoolingThresholdTemperature(value: CharacteristicValue): Promise<void> {
    this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} Set CoolingThresholdTemperature: ${value}`);
    this.CoolingThresholdTemperature = value;
    this.doThermostatUpdate.next();
  }

  async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} Set TargetTemperature: ${value}`);
    this.TargetTemperature = value;
    this.doThermostatUpdate.next();
  }

  async setTemperatureDisplayUnits(value: CharacteristicValue): Promise<void> {
    this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} Set TemperatureDisplayUnits: ${value}`);
    this.platform.log.warn('Changing the Hardware Display Units from HomeKit is not supported.');

    // change the temp units back to the one the Resideo API said the thermostat was set to
    setTimeout(() => {
      this.service.updateCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits, this.TemperatureDisplayUnits);
    }, 100);
  }

  /**
   * Converts the value to celsius if the temperature units are in Fahrenheit
   */
  toCelsius(value: number): number {
    if (this.TemperatureDisplayUnits === this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS) {
      return value;
    }

    // celsius should be to the nearest 0.5 degree
    return Math.round((5 / 9) * (value - 32) * 2) / 2;
  }

  /**
   * Converts the value to fahrenheit if the temperature units are in Fahrenheit
   */
  toFahrenheit(value: number): number {
    if (this.TemperatureDisplayUnits === this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS) {
      return value;
    }

    return Math.round((value * 9) / 5 + 32);
  }

  TargetState(): number[] {
    this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} allowedModes: ${this.device.allowedModes}`);

    const TargetState = [4];
    TargetState.pop();
    if (this.device.allowedModes!.includes('Cool')) {
      TargetState.push(this.platform.Characteristic.TargetHeatingCoolingState.COOL);
    }
    if (this.device.allowedModes!.includes('Heat')) {
      TargetState.push(this.platform.Characteristic.TargetHeatingCoolingState.HEAT);
    }
    if (this.device.allowedModes!.includes('Off')) {
      TargetState.push(this.platform.Characteristic.TargetHeatingCoolingState.OFF);
    }
    if (this.device.allowedModes!.includes('Auto')) {
      TargetState.push(this.platform.Characteristic.TargetHeatingCoolingState.AUTO);
    }
    this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} Only Show These Modes: ${superStringify(TargetState)}`);
    return TargetState;
  }

  async config(device: settings.device & settings.devicesConfig): Promise<void> {
    let config = {};
    if (device.thermostat?.roompriority) {
      config = device.thermostat?.roompriority;
    }
    if (device.thermostat?.roompriority?.logging !== undefined) {
      config['logging'] = device.thermostat?.roompriority?.logging;
    }
    if (device.thermostat?.roompriority?.refreshRate !== undefined) {
      config['refreshRate'] = device.thermostat?.roompriority?.refreshRate;
    }
    if (Object.entries(config).length !== 0) {
      this.infoLog(`Room Sensor Thermostat: ${this.accessory.displayName} Config: ${superStringify(config)}`);
    }
  }

  async refreshRate(device: settings.device & settings.devicesConfig): Promise<void> {
    if (device.thermostat?.roompriority?.refreshRate) {
      this.deviceRefreshRate = this.accessory.context.refreshRate = device.thermostat?.roompriority?.refreshRate;
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} Using Device Config refreshRate: ${this.deviceRefreshRate}`);
    } else if (device.refreshRate) {
      this.deviceRefreshRate = this.accessory.context.refreshRate = device.refreshRate;
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} Using Thermostat Device Config refreshRate: ${this.deviceRefreshRate}`);
    } else if (this.platform.config.options!.refreshRate) {
      this.deviceRefreshRate = this.accessory.context.refreshRate = this.platform.config.options!.refreshRate;
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} Using Platform Config refreshRate: ${this.deviceRefreshRate}`);
    }
  }

  async logs(device: settings.device & settings.devicesConfig): Promise<void> {
    if (this.platform.debugMode) {
      this.deviceLogging = this.accessory.context.logging = 'debugMode';
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} Using Debug Mode Logging: ${this.deviceLogging}`);
    } else if (device.thermostat?.roompriority?.logging) {
      this.deviceLogging = this.accessory.context.logging = device.thermostat?.roompriority?.logging;
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} Using Device Config Logging: ${this.deviceLogging}`);
    } else if (this.platform.config.options?.logging) {
      this.deviceLogging = this.accessory.context.logging = this.platform.config.options?.logging;
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} Using Platform Config Logging: ${this.deviceLogging}`);
    } else {
      this.deviceLogging = this.accessory.context.logging = 'standard';
      this.debugLog(`Room Sensor Thermostat: ${this.accessory.displayName} Logging Not Set, Using: ${this.deviceLogging}`);
    }
  }

  /**
   * Logging for Device
   */
  infoLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      this.platform.log.info(String(...log));
    }
  }

  warnLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      this.platform.log.warn(String(...log));
    }
  }

  debugWarnLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      if (this.deviceLogging?.includes('debug')) {
        this.platform.log.warn('[DEBUG]', String(...log));
      }
    }
  }

  errorLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      this.platform.log.error(String(...log));
    }
  }

  debugErrorLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      if (this.deviceLogging?.includes('debug')) {
        this.platform.log.error('[DEBUG]', String(...log));
      }
    }
  }

  debugLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      if (this.deviceLogging === 'debug') {
        this.platform.log.info('[DEBUG]', String(...log));
      } else {
        this.platform.log.debug(String(...log));
      }
    }
  }

  enablingDeviceLogging(): boolean {
    return this.deviceLogging.includes('debug') || this.deviceLogging === 'standard';
  }
}
