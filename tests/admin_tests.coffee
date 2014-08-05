batchId = "mturkBatch"
hitTypeId = "mturkHITType"

# Create dummy batch and HIT Type
Batches.upsert batchId, $set: {}

HITTypes.upsert {HITTypeId: hitTypeId},
  $set: { batchId }

# Temporarily disable the admin check during these tests
_checkAdmin = TurkServer.checkAdmin

withCleanup = TestUtils.getCleanupWrapper
  before: ->
    Batches.upsert batchId, $set:
      { active: false }
    TurkServer.checkAdmin = ->

  after: ->
    HITs.remove { HITTypeId: hitTypeId }

    # Clean up emails and workers created for testing e-mails
    WorkerEmails.remove({})
    Workers.remove({test: "email"})

    TestUtils.mturkAPI.handler = null
    TurkServer.checkAdmin = _checkAdmin

Tinytest.add "admin - create HIT for active batch", withCleanup (test) ->

  newHitId = Random.id()
  TestUtils.mturkAPI.handler = (op, params) -> newHitId
  Batches.upsert batchId, $set: { active: true }

  # test
  Meteor.call "ts-admin-create-hit", hitTypeId, {}

  hit = HITs.findOne(HITId: newHitId)

  test.isTrue(hit)
  test.equal hit.HITId, newHitId
  test.equal hit.HITTypeId, hitTypeId

Tinytest.add "admin - create HIT for inactive batch", withCleanup (test) ->

  test.throws ->
    Meteor.call "ts-admin-create-hit", hitTypeId, {}
  , (e) -> e.error is 403

Tinytest.add "admin - extend HIT for active batch", withCleanup (test) ->

  HITId = Random.id()
  HITs.insert { HITId, HITTypeId: hitTypeId }
  Batches.upsert batchId, $set: { active: true }

  # Need to return something for GetHIT else massive complaining
  TestUtils.mturkAPI.handler = (op, params) ->
    switch op
      when "GetHIT" then {}

  Meteor.call "ts-admin-extend-hit", { HITId }

Tinytest.add "admin - extend HIT for inactive batch", withCleanup (test) ->

  HITId = Random.id()
  HITs.insert { HITId, HITTypeId: hitTypeId }

  test.throws ->
    Meteor.call "ts-admin-extend-hit", { HITId }
  (e) -> e.error is 403

Tinytest.add "admin - email - create message from existing", withCleanup (test) ->
  workers = (Random.id() for i in [1..100])

  existingId = WorkerEmails.insert
    subject: "test"
    message: "test message"
    recipients: workers

  subject = "test2"
  message = "another test message"

  newId = Meteor.call "ts-admin-create-message", subject, message, existingId

  newEmail = WorkerEmails.findOne(newId)

  test.equal newEmail.subject, subject
  test.equal newEmail.message, message
  test.length newEmail.recipients, workers.length
  test.isTrue _.isEqual(newEmail.recipients, workers)
  test.isFalse newEmail.sentTime

Tinytest.add "admin - email - send and record message", withCleanup (test) ->
  # Create fake workers
  workerIds = ( Workers.insert({test: "email"}) for x in [1..100] )
  test.equal workerIds.length, 100

  subject = "test sending"
  message = "test sending message"

  emailId = WorkerEmails.insert
    subject: subject
    message: message
    recipients: workerIds

  # Record all the API calls that were made
  apiWorkers = []
  TestUtils.mturkAPI.handler = (op, params) ->
    test.equal params.Subject, subject
    test.equal params.MessageText, message
    apiWorkers = apiWorkers.concat(params.WorkerId)

  count = Meteor.call "ts-admin-send-message", emailId

  test.equal count, workerIds.length
  test.length apiWorkers, workerIds.length
  test.isTrue _.isEqual(apiWorkers, workerIds)

  # Test that email sending got saved to workers
  checkedWorkers = 0
  Workers.find({_id: $in: workerIds}).forEach (worker) ->
    test.equal worker.emailsReceived[0], emailId
    checkedWorkers++

  test.equal checkedWorkers, workerIds.length

  # Test that sent date was recorded
  test.instanceOf WorkerEmails.findOne(emailId).sentTime, Date
