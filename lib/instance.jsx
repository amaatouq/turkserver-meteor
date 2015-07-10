const init_queue = [];

/*
  XXX Note that the collection called "Experiments" now actually refers to instances
 */

/**
 * @summary Get the treatments of the current instance
 * @locus Anywhere
 * @returns The treatments of the currently scoped instance
 */
TurkServer.treatment = () => {
  const inst = TurkServer.Instance.currentInstance();
  return inst && inst.treatment();
};

// map of groupId to instance objects
// XXX Can't use WeakMap here because we have primitive keys
const _instances = new Map();

/**
 * @summary Represents a group or slice on the server, containing some users.
  * These functions are available only on the server. This object is
  * automatically constructed from TurkServer.Instance.getInstance.
 * @class TurkServer.Instance
 * @instancename instance
 */
class Instance {

  /**
   * @function TurkServer.Instance.getInstance
   * @summary Get the instance by its id.
   * @param {String} groupId
   * @returns {TurkServer.Instance} the instance, if it exists
   */
  static getInstance(groupId) {
    check(groupId, String);

    let inst = _instances.get(groupId);
    if( inst != null ) return inst;

    if (Experiments.findOne(groupId) == null) {
      throw new Error(`Instance does not exist: ${groupId}`);
    }

    // A fiber may have created this at the same time; if so use that one
    if( inst = _instances.get(groupId) && inst != null ) return inst;

    inst = new TurkServer.Instance(groupId);
    _instances.set(groupId, inst);
    return inst;
  }

  /**
   * @function TurkServer.Instance.currentInstance
   * @summary Get the currently scoped instance
   * @returns {TurkServer.Instance} the instance, if it exists
   */
  static currentInstance() {
    const groupId = Partitioner.group();
    return groupId && this.getInstance(groupId);
  }

  /**
   * @function TurkServer.Instance.initialize
   * @summary Schedules a new handler to be called when an instance is initialized.
   * @param {Function} handler
   */
  static initialize(handler) {
    init_queue.push(handler);
  }

  constructor(groupId) {
    if ( _instances.get(groupId) ) {
      throw new Error("Instance already exists; use getInstance");
    }

    this.groupId = groupId;
  }

  /**
   * @function TurkServer.Instance#bindOperation
   * @summary Run a function scoped to this instance with a given context. The
   * value of context.instance will be set to this instance.
   * @param {Function} func The function to execute.
   * @param {Object} context Optional context to pass to the function.
   */
  bindOperation(func, context = {}) {
    context.instance = this;
    Partitioner.bindGroup(this.groupId, func.bind(context));
  }

  /**
   * @function TurkServer.Instance#setup
   * @summary Run the initialization handlers for this instance
   */
  setup() {
    // Can't use fat arrow here.
    this.bindOperation( function() {
      TurkServer.log({
        _meta: "initialized",
        treatmentData: this.instance.treatment()
      });

      for( var handler of init_queue ) {
        handler.call(this);
      }

    });
  }

  /**
   * @function TurkServer.Instance#addAssignment
   * @summary Add an assignment (connected user) to this instance.
   * @param {TurkServer.Assignment} asst The user assignment to add.
   */
  addAssignment(asst) {
    check(asst, TurkServer.Assignment);

    if (this.isEnded()) {
      throw new Error("Cannot add a user to an instance that has ended.");
    }

    // Add a user to this instance
    Partitioner.setUserGroup(asst.userId, this.groupId);

    Experiments.update(this.groupId, {
      $addToSet: {
        users: asst.userId
      }
    });

    Meteor.users.update(asst.userId, {
      $set: {
        "turkserver.state": "experiment"
      }
    });

    // Set experiment start time if this was first person to join
    Experiments.update({
      _id: this.groupId,
      startTime: null
    }, {
      $set: {
        startTime: new Date
      }
    });

    // Record instance Id in Assignment
    asst._joinInstance(this.groupId);
  }

  /**
   * @function TurkServer.Instance#users
   * @summary Get the users that are part of this instance.
   * @returns {Array} the list of userIds
   */
  users() {
    return Experiments.findOne(this.groupId).users || [];
  }

  /**
   * @function TurkServer.Instance#batch
   * @summary Get the batch that this instance is part of.
   * @returns {TurkServer.Batch} the batch
   */
  batch() {
    const instance = Experiments.findOne(this.groupId);
    return instance && TurkServer.Batch.getBatch(instance.batchId);
  }

  /**
   * @function TurkServer.Instance#treatment
   * @summary Get the treatment parameters for this instance.
   * @returns {Object} The treatment parameters.
   */
  treatment() {
    const instance = Experiments.findOne(this.groupId);

    return instance && TurkServer._mergeTreatments(Treatments.find({
      name: {
        $in: instance.treatments
      }
    }));
  }

  /**
   * @function TurkServer.Instance#getDuration
   * @summary How long this experiment has been running, in milliseconds
   * @returns {Number} Milliseconds that the experiment has been running.
   */
  getDuration() {
    const instance = Experiments.findOne(this.groupId);
    return (instance.endTime || new Date) - instance.startTime;
  }

  /**
   * @function TurkServer.Instance#isEnded
   * @summary Whether the instance is ended. If an instance is ended, it has a
   * recorded endTime and can't accept new users.
   * @returns {Boolean} Whether the experiment is ended
   */
  isEnded() {
    const instance = Experiments.findOne(this.groupId);
    return instance && instance.endTime != null;
  }

  /**
   * @function TurkServer.Instance#teardown
   * @summary Close this instance, optionally returning people to the lobby
   * @param {Boolean} returnToLobby Whether to return users to lobby after
   * teardown. Defaults to true.
   */
  teardown(returnToLobby = true) {
    // Set the same end time for all logs
    const now = new Date();

    Partitioner.bindGroup(this.groupId, function() {
      return TurkServer.log({
        _meta: "teardown",
        _timestamp: now
      });
    });

    Experiments.update(this.groupId, {
      $set: {
        endTime: now
      }
    });

    // Sometimes we may want to allow users to continue to access partition data
    /* TODO if the user returns to lobby after teardown,
      assignment time computations could be a bit off.
     */
    if( !returnToLobby ) return;

    const users = Experiments.findOne(this.groupId).users;
    if (users == null) return;

    for( userId of users ) {
      this.sendUserToLobby(userId);
    }
  }

  /**
   * @function TurkServer.Instance#sendUserToLobby
   * @summary Send a user that is part of this instance back to the lobby.
   * @param {String} userId The user to return to the lobby.
   */
  sendUserToLobby(userId) {
    Partitioner.clearUserGroup(userId);
    let asst = TurkServer.Assignment.getCurrentUserAssignment(userId);
    if (asst == null) return;

    // If the user is still assigned, do final accounting and put them in lobby
    asst._leaveInstance(this.groupId);
    this.batch().lobby.addAssignment(asst);
  }
}

TurkServer.Instance = Instance;

// XXX back-compat
TurkServer.initialize = TurkServer.Instance.initialize;