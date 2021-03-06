const {
  setBoundActionCreators,
  // queue: jobQueue,
  // reportError,
  _unstable_createJob,
} = require(`./index`)
const { pathExists } = require(`fs-extra`)
const { slash, isCI } = require(`gatsby-core-utils`)
const { trackFeatureIsUsed } = require(`gatsby-telemetry`)
const { getProgressBar, createOrGetProgressBar } = require(`./utils`)

const { setPluginOptions } = require(`./plugin-options`)
const path = require(`path`)

function prepareLazyImagesExperiment(reporter) {
  if (!process.env.GATSBY_EXPERIMENTAL_LAZY_IMAGES) {
    return
  }
  if (process.env.gatsby_executing_command !== `develop`) {
    // We don't want to ever have this flag enabled for anything other than develop
    // in case someone have this env var globally set
    delete process.env.GATSBY_EXPERIMENTAL_LAZY_IMAGES
    return
  }
  if (isCI()) {
    delete process.env.GATSBY_EXPERIMENTAL_LAZY_IMAGES
    reporter.warn(
      `Lazy Image Processing experiment is not available in CI environment. Continuing with regular mode.`
    )
    return
  }
  // We show a different notice for GATSBY_EXPERIMENTAL_FAST_DEV umbrella
  if (!process.env.GATSBY_EXPERIMENTAL_FAST_DEV) {
    reporter.info(
      `[gatsby-plugin-sharp] The lazy image processing experiment is enabled`
    )
  }
  trackFeatureIsUsed(`LazyImageProcessing`)
}

exports.onPreInit = ({ reporter }) => {
  prepareLazyImagesExperiment(reporter)
}

// create the progressbar once and it will be killed in another lifecycle
const finishProgressBar = () => {
  const progressBar = getProgressBar()
  if (progressBar) {
    progressBar.done()
  }
}

exports.onPostBuild = () => finishProgressBar()

exports.onCreateDevServer = async ({ app, cache, reporter }) => {
  if (!process.env.GATSBY_EXPERIMENTAL_LAZY_IMAGES) {
    finishProgressBar()
    return
  }

  createOrGetProgressBar()
  finishProgressBar()

  app.use(async (req, res, next) => {
    const pathOnDisk = path.resolve(path.join(`./public/`, req.url))

    if (await pathExists(pathOnDisk)) {
      return res.sendFile(pathOnDisk)
    }

    const jobContentDigest = await cache.get(req.url)
    const cacheResult = jobContentDigest
      ? await cache.get(jobContentDigest)
      : null

    if (!cacheResult) {
      return next()
    }

    await _unstable_createJob(cacheResult, { reporter })
    // we should implement cache.del inside our abstraction
    await cache.cache.del(jobContentDigest)
    await cache.cache.del(req.url)

    return res.sendFile(pathOnDisk)
  })
}

// So something is wrong with the reporter, when I do this in preBootstrap,
// the progressbar gets not updated
exports.onPostBootstrap = async ({ reporter, cache, store }) => {
  if (process.env.gatsby_executing_command !== `develop`) {
    // recreate jobs that haven't been triggered by develop yet
    // removing stale jobs has already kicked in so we know these still need to process
    for (const [contentDigest] of store.getState().jobsV2.complete) {
      const job = await cache.get(contentDigest)

      if (job) {
        // we dont have to await, gatsby does this for us
        _unstable_createJob(job, { reporter })
      }
    }
  }
}

exports.onPreBootstrap = async (
  { actions, emitter, reporter, cache, store },
  pluginOptions
) => {
  setBoundActionCreators(actions)
  setPluginOptions(pluginOptions)

  // below is a hack / hot fix for confusing progress bar behaviour
  // that doesn't recognize duplicate jobs, as it's now
  // in gatsby core internals (if `createJobV2` is available)
  // we should remove this or make this code path not hit
  // (we should never use emitter in plugins)
  // as soon as possible (possibly by moving progress bar handling
  // inside jobs-manager in core)

  if (emitter) {
    // track how many image transformation each job has
    // END_JOB_V2 doesn't contain that information
    // so we store it in <JobContentHash, TransformsCount> map
    // when job is created. Then retrieve that when job finishes
    // and remove that entry from the map.
    const imageCountInJobsMap = new Map()

    emitter.on(`CREATE_JOB_V2`, action => {
      if (action.plugin.name === `gatsby-plugin-sharp`) {
        if (action.payload.job.args.isLazy) {
          // we have to remove some internal pieces
          const job = {
            name: action.payload.job.name,
            inputPaths: action.payload.job.inputPaths.map(input => input.path),
            outputDir: action.payload.job.outputDir,
            args: {
              ...action.payload.job.args,
              isLazy: false,
            },
          }
          cache.set(action.payload.job.contentDigest, job)

          action.payload.job.args.operations.forEach(op => {
            const cacheKey = slash(
              path.relative(
                path.join(process.cwd(), `public`),
                path.join(action.payload.job.outputDir, op.outputPath)
              )
            )

            cache.set(`/${cacheKey}`, action.payload.job.contentDigest)
          })

          return
        }

        const job = action.payload.job
        const imageCount = job.args.operations.length
        imageCountInJobsMap.set(job.contentDigest, imageCount)
        const progress = createOrGetProgressBar(reporter)
        progress.addImageToProcess(imageCount)
      }
    })

    emitter.on(`END_JOB_V2`, action => {
      if (action.plugin.name === `gatsby-plugin-sharp`) {
        const jobContentDigest = action.payload.jobContentDigest

        // when it's lazy we didn't set it
        if (!imageCountInJobsMap.has(jobContentDigest)) {
          return
        }

        const imageCount = imageCountInJobsMap.get(jobContentDigest)
        const progress = createOrGetProgressBar(reporter)
        progress.tick(imageCount)
        imageCountInJobsMap.delete(jobContentDigest)
      }
    })
  }

  // normalizedOptions = setPluginOptions(pluginOptions)
}

exports.pluginOptionsSchema = ({ Joi }) =>
  Joi.object({
    base64Width: Joi.number()
      .default(20)
      .description(`The width of the generated base64 preview image`),
    forceBase64Format: Joi.any()
      .valid(`png`, `jpg`, `webp`)
      .description(
        `Force a different format for the generated base64 image. Defaults to the same format as the input image`
      ),
    useMozJpeg: Joi.boolean().description(
      `The the mozJpeg library for encoding. Defaults to false, unless \`process.env.GATSBY_JPEG_ENCODER\` === \`MOZJPEG\``
    ),
    stripMetadata: Joi.boolean().default(true),
    defaultQuality: Joi.number().default(50),
    failOnError: Joi.boolean().default(true),
  })
