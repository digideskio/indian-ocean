// var flatten = require('flat')
var fs = require('fs')
var dsv = require('d3-dsv')
var dbf = require('dbf')
var shapefileDbf = require('shapefile/dbf')
var path = require('path')
var queue = require('queue-async')
var _ = require('underscore')
var chalk = require('chalk')
var json_parser = require('parse-json') // This library has better error reporting of malformed json.
var yaml_parser = require('js-yaml')
var mkdirp = require('mkdirp')
var archieml = require('archieml')

var formatters = {
  json: function (file) {
    return JSON.stringify(file)
  },
  csv: function (file) {
    file = formattingPreflight(file, 'csv')
    try {
      return dsv.csv.format(file)
    } catch (err) {
      reporters.parseError('csv')
    }
  },
  tsv: function (file) {
    file = formattingPreflight(file, 'tsv')
    try {
      return dsv.tsv.format(file)
    } catch (err) {
      reporters.parseError('tsv')
    }
  },
  psv: function (file) {
    file = formattingPreflight(file, 'psv')
    try {
      return dsv.dsv('|').format(file)
    } catch (err) {
      reporters.parseError('psv')
    }
  },
  yaml: function (file) {
    return yaml_parser.dump(file)
  },
  txt: function (file) {
    return file
  },
  dbf: function (file) {
    function toBuffer (ab) {
      var buffer = new Buffer(ab.byteLength)
      var view = new Uint8Array(ab)
      for (var i = 0; i < buffer.length; ++i) {
        buffer[i] = view[i]
      }
      return buffer
    }
    var buf = dbf.structure(file)
    return toBuffer(buf.buffer)
  }
}

// Each parser must return the parsed data
// For legacy support, they can also have a `.parse` method
var parsers = {
  json: json_parser,
  csv: dsv.csv.parse,
  tsv: dsv.tsv.parse,
  psv: dsv.dsv('|').parse,
  txt: function (data) {
    // Because we pass `utf-8` in to `readFile` and `readFileSync`, our data object is going to be a string, so we can simply return it
    return data
  },
  yaml: function (data) {
    return yaml_parser.load(data)
  },
  aml: archieml.load
}

// Alias `.yml` to `.yaml`
parsers.yml = parsers.yaml

var reporters = {}

reporters.warn = function (msg) {
  console.log(chalk.gray('[indian-ocean]') + ' ' + chalk.yellow('Warning:', msg))
}

reporters.parseError = function (format) {
  throw new Error(chalk.red('[indian-ocean] Error converting your data to ' + chalk.bold(format) + '.') + '\n\n' + chalk.cyan('Your data most likely contains objects or lists. Object values can only be strings for this format. Please convert before writing to file.\n'))
}

reporters.notListError = function (format) {
  throw new Error(chalk.red('[indian-ocean] You passed in an object but converting to ' + chalk.bold(format) + ' requires a list of objects.') + chalk.cyan('\nIf you would like to write a one-row csv, put your object in a list like so: `' + chalk.bold('[data]') + '`\n'))
}

/**
  * Various utility functions.
  * @namespace
*/
var helpers = {}

/**
 * Given a `fileName` return its file extension. Used internally by `.discernPaser` and `.discernFileFormatter`.
 * @param {String} fileName the name of the file
 * @returns {String} the file's extension
 *
 * @example
 * var format = io.discernFormat('path/to/data.csv')
 * console.log(format) // 'csv'
 */
helpers.discernFormat = function (fileName) {
  var extension = path.extname(fileName)
  if (extension === '') return false

  var formatName = extension.slice(1)
  // If it ends in json such as `topojson` or `geojson`, call it json.
  if (formatName.substr(formatName.length - 4) === 'json') {
    formatName = 'json'
  }
  return formatName
}

/**
 * Given a `fileName`, optionally a delimiter, return a parser that can read that file as json. Parses as text if format not supported. Used internally by `.readData` and `.readDataSync`.
 * @param {String} fileName the name of the file
 * @param {Object} options optionally can take a delimiter value
 * @returns {Object} a parser that can read the file
 *
 * @example
 * var parser = io.discernParser('path/to/data.csv');
 * var json = parser('path/to/data.csv');

 * var parser = io.discernParser('path/to/data.usv', {delimiter: '_'});
 * var json = parser('path/to/data.usv');
 */
helpers.discernParser = function (fileName, opts_) {
  if (opts_ && opts_.delimiter) {
    return dsv.dsv(opts_.delimiter)
  }
  var format = helpers.discernFormat(fileName)
  var parser = parsers[format]
  // If we don't have a parser for this format, return as text
  if (typeof parser === 'undefined') {
    parser = parsers['txt']
  }
  return parser
}

/**
 * Returns a formatter that will format json data to file type specified by the extension in `fileName`. Used internally by `.writeData` and `.writeDataSync`.
 * @param {String} fileName the name of the file
 * @returns {Object} a formatter that can write the file
 *
 * @example
 * var formatter = io.discernFileFormatter('path/to/data.tsv');
 * var csv = formatter(json);
 */
helpers.discernFileFormatter = function (fileName) {
  var format = helpers.discernFormat(fileName)
  var formatter = formatters[format]
  // If we don't have a parser for this format, return as text
  if (typeof formatter === 'undefined') {
    formatter = formatters['txt']
  }
  return formatter
}

/**
 * Asynchronously test whether a file exists or not by using `fs.access` modified from https://github.com/nodejs/io.js/issues/1592#issuecomment-98392899.
 * @param {String} fileName the name of the file
 * @param {Function} callback has the signature `(err, exists)`
 *
 * @example
 * var exists = io.exists('path/to/data.tsv', function (err, exists) {
 *   console.log(exists) // `true` if the file exists, `false` if not.
 * })
 *
 */
helpers.exists = function (filename, cb) {
  fs.access(filename, function (err) {
    var exists
    if (err && err.code === 'ENOENT') {
      exists = false
      err = null
    } else if (!err) {
      exists = true
    }
    cb(err, exists)
  })
}

/**
 * Syncronous version of {@link helpers#exists}
 *
 * @param {String} fileName the name of the file
 * @returns {Boolean} whether the file exists or not
 *
 * @example
 * var exists = io.existsSync('path/to/data.tsv')
 * console.log(exists) // `true` if file exists, `false` if not.
 */
helpers.existsSync = function (filename) {
  try {
    fs.accessSync(filename)
    return true
  } catch(ex) {
    return false
  }
}

/**
 * Asynchronously Create directories in a given file path
 *
 * @param {String} outPath The path to a file
 * @param {Function} callback The function to do once this is done. Has signature of `(err)`
 *
 * @example
 * io.makeDirectories('path/to/create/to/data.tsv', function (err) {
 *   console.log(err) // null
 * })
 *
 */
helpers.makeDirectories = function (outPath, nextStep) {
  mkdirp(path.dirname(outPath), function (err) {
    nextStep(err)
  })
}

/**
 * Synchronous version of `makeDirectories`
 *
 * @param {String} outPath The path to a file
 *
 * @example
 * io.makeDirectories('path/to/create/to/data.tsv')
 *
 */
helpers.makeDirectoriesSync = function (outPath) {
  mkdirp.sync(path.dirname(outPath))
}

/**
 * Test whether a file name has the given extension
 *
 * @param {String} fileName The name of the file
 * @param {String} extension The extension to test
 * @returns {Boolean} whether The extension matched or not
 *
 * @example
 * var matches = io.extensionMatches('path/to/data.tsv', 'tsv')
 * console.log(matches) // `true`
 */
helpers.extensionMatches = function (fileName, extension) {
  // Chop '.' off extension returned by extname
  return path.extname(fileName).slice(1) === extension
}

/**
 * Test whether a string matches a given Regular Expression
 *
 * @param {String} fileName The name of the file
 * @param {RegExp} RegEx The RegEx to match with
 * @returns {Boolean} whether The string matches the RegEx
 *
 * @example
 * var matches = io.matchRegExp('.gitignore', /\.gitignore/)
 * console.log(matches) // `true`
 */
helpers.matchRegExp = function (fileName, regEx) {
  return regEx.test(fileName)
}

/**
 * Test whether a file name matches a given matcher. Delegates to {@link helpers#extensionMatches} if `matcher` is a string`, {@link helpers#matchRegExp} if Regular Expression
 *
 * @param {String} fileName The name of the file
 * @returns {String} matcher The string to match with
 *
 * @example
 * var matches = io.matches('path/to/data.tsv', 'tsv')
 * console.log(matches) // `true`
 *
 * var matches = io.matches('.gitignore', /\.gitignore/)
 * console.log(matches) // `true`
 */
helpers.matches = function (fileName, matcher) {
  if (typeof matcher === 'string') {
    return helpers.extensionMatches(fileName, matcher)
  } else if (_.isRegExp(matcher)) {
    return helpers.matchRegExp(fileName, matcher)
  } else {
    throw new Error('Matcher argument must be String or Regular Expression')
  }
}

/**
 * A port of jQuery's extend. Merge the contents of two or more objects together into the first object. Supports deep extending with `true` as the first argument.
 *
 * @param {Boolean} [deepExtend] Set to `true` to merge recursively.
 * @param {Object} destination The object to modify
 * @param {Object} source The object whose contents to take
 * @param {Object} [source2] You can add any number of objects as arguments.
 * @returns {Object} result The merged object. Note that the `destination` object will always be modified.
 *
 * @example
 * var mergedObj = io.extend({}, {name: 'indian-ocean'}, {alias: 'io'})
 * console.log(mergedObj)
 * // {
 * //   name: 'indian-ocean',
 * //   alias: 'io'
 * // }
 *
 * var name = {name: 'indian-ocean'}
 * io.extend(name, {alias: 'io'})
 * console.log(name)
 * // {
 * //   name: 'indian-ocean',
 * //   alias: 'io'
 * // }
 *
 * @example
 * var object1 = {
 *   apple: 0,
 *   banana: { weight: 52, price: 100 },
 *   cherry: 97
 * }
 * var object2 = {
 *   banana: { price: 200 },
 *   almond: 100
 * }
 * io.extend(true, object1, object2)
 * console.log(object1)
 * //  {
 * //   apple: 0,
 * //   banana: {
 * //     weight: 52,
 * //     price: 200
 * //   },
 * //   cherry: 97,
 * //   almond: 100
 * // }
 *
 */
helpers.extend = function () {
  var options
  var name
  var src
  var copy
  var copyIsArray
  var clone
  var target = arguments[0] || {}
  var i = 1
  var length = arguments.length
  var deep = false

  // Handle a deep copy situation
  if (typeof target === 'boolean') {
    deep = target

    // Skip the boolean and the target
    target = arguments[i] || {}
    i++
  }

  // Handle case when target is a string or something (possible in deep copy)
  if (typeof target !== 'object' && !_.isFunction(target)) {
    target = {}
  }

  // Extend indian-ocean itself if only one argument is passed
  if (i === length) {
    target = this
    i--
  }

  for (; i < length; i++) {

    // Only deal with non-null/undefined values
    if ((options = arguments[i]) != null) {

      // Extend the base object
      for (name in options) {
        src = target[name]
        copy = options[name]

        // Prevent never-ending loop
        if (target === copy) {
          continue
        }

        // Recurse if we're merging plain objects or arrays
        if (deep && copy && (_.isObject(copy) ||
            (copyIsArray = _.isArray(copy)))) {

          if (copyIsArray) {
            copyIsArray = false
            clone = src && _.isArray(src) ? src : []

          } else {
            clone = src && _.isObject(src) ? src : {}
          }

          // Never move original objects, clone them
          target[name] = helpers.extend(deep, clone, copy)

          // Don't bring in undefined values
        } else if (copy !== undefined) {
          target[name] = copy
        }
      }
    }
  }

  // Return the modified object
  return target
}

/**
 * A more semantic convenience function. Delegates to {@link helpers#extend} and passes `true` as the first argument. Recursively merge the contents of two or more objects together into the first object.
 *
 * @param {Object} destination The object to modify
 * @param {Object} source The object whose contents to take
 * @param {Object} [source2] You can add any number of objects as arguments.
 * @returns {Object} result The merged object. Note that the `destination` object will always be modified.
 *
 * @example
 * var object1 = {
 *   apple: 0,
 *   banana: { weight: 52, price: 100 },
 *   cherry: 97
 * }
 * var object2 = {
 *   banana: { price: 200 },
 *   almond: 100
 * }
 * io.deepExtend(object1, object2)
 * console.log(object1)
 * //  {
 * //   apple: 0,
 * //   banana: {
 * //     weight: 52,
 * //     price: 200
 * //   },
 * //   cherry: 97,
 * //   almond: 100
 * // }
 *
 */
helpers.deepExtend = function () {
  var args = Array.prototype.slice.call(arguments) // Make real array from arguments
  args.unshift(true) // Add `true` as first arg.
  helpers.extend.apply(this, args)
}

// Some shared data integrity checks for formatters
function formattingPreflight (file, format) {
  if (file === '') {
    return []
  } else if (!_.isArray(file)) {
    reporters.notListError(format)
  }
  return file
}

// Our `readData` fns can take either a delimiter to parse a file, or a full blown parser
// Determine what they passed in with this handy function
function getDelimiterOrParser (delimiterOrParser) {
  var delimiter
  var parser
  if (typeof delimiterOrParser === 'string') {
    delimiter = delimiterOrParser
    parser = helpers.discernParser(null, delimiter)
  } else if (_.isObject(delimiterOrParser)) {
    parser = delimiterOrParser
  }
  return parser
}

/**
  * Functions to read data files.
  * @namespace
*/
var readers = {}

/**
 * Asynchronously read data given a path ending in the file format.
 *
 * Supported formats / extensions:
 *
 * * `.json` Array of objects
 * * `.csv` Comma-separated
 * * `.tsv` Tab-separated
 * * `.psv` Pipe-separated
 * * `.yaml` or `.yml` Yaml file
 * * `.aml` ArchieML
 * * `.txt` Text file (a string)
 * * other All others are read as a text file
 *
 * *Note: Does not currently support `.dbf` files. `.yaml` and `.yml` formats are read with js-yaml's `.load` method, which has no security checking. See js-yaml library for more secure options.*
 *
 * @param {String} fileName the name of the file
 * @param {Object} [options] optional See options below
 * @param {String|Function|Object} [options.parser] optional This can be a string that is the file's delimiter or a function that returns the json. See `parsers` in library source for examples. For convenience, this can also take a dsv object such as `dsv.dsv('_')` or any object that has a `parse` method. Pre-version 1.1 this was called `parseWith` and to maintain support, that will still work.
 * @param {Function} callback callback used when read data is read, takes error (if any) and the data read
 *
 * @example
 * io.readData('path/to/data.tsv', function (err, data) {
 *   console.log(data) // Json data
 * })
 *
 * io.readData('path/to/data.usv', {parser: '_'}, function (err, data) {
 *   console.log(data) // Json data
 * })
 *
 * var myParser = dsv.dsv('_')
 * io.readData('path/to/data.usv', {parser: myParser}, function (err, data) {
 *   console.log(data) // Json data
 * })
 *
 * var naiveJsonLines = function (dataAsString) {
 *   return dataAsString.split('\n').map(function (row) { return JSON.parse(row) })
 * }
 * io.readData('path/to/data.jsonlines', {parser: naiveJsonLines}, function (err, data) {
 *   console.log(data) // Json data
 * })
 *
 */
readers.readData = function (path, opts_, cb_) {
  var cb = arguments[arguments.length - 1]
  var parser
  var parseWith
  if (arguments.length === 3) {
    parseWith = opts_.parseWith || opts_.parser
    parser = getDelimiterOrParser(parseWith)
  } else {
    parser = helpers.discernParser(path)
  }
  fs.readFile(path, 'utf8', function (err, data) {
    if (helpers.discernFormat(path) === 'json' && data === '') {
      data = '[]'
    }
    if (_.isFunction(parser)) {
      cb(err, parser(data))
    } else if (_.isObject(parser.parse) && _.isFunction(parser.parse)) {
      cb(err, parser.parse(data))
    } else {
      cb('Your specified parser is not properly formatted. It must either be a function or have a `parse` method.')
    }
  })
}

/**
 * Syncronous version of {@link readers#readData}
 *
 * @param {String} fileName the name of the file
 * @param {Object} [options] optional See options below
 * @param {String|Function|Object} [options.parser] optional This can be a string that is the file's delimiter or a function that returns the json. See `parsers` in library source for examples. For convenience, this can also take a dsv object such as `dsv.dsv('_')` or any object that has a `parse` method. Pre-version 1.1 this was called `parseWith` and to maintain support, that will still work.
 * @returns {Object} the contents of the file as JSON
 *
 * @example
 * io.readDataSync('path/to/data.tsv')
 * console.log(data) // Json data
 *
 * io.readDataSync('path/to/data.usv', {parser: '_'})
 * console.log(data) // Json data
 *
 * var myParser = dsv.dsv('_')
 * io.readDataSync('path/to/data.usv', {parser: myParser})
 * console.log(data) // Json data
 *
 * var naiveJsonLines = function(dataAsString)
 *   return dataAsString.split('\n').map(function (row) { return JSON.parse(row) })
 * }
 * io.readDataSync('path/to/data.jsonlines', {parser: naiveJsonLines})
 * console.log(data) // Json data
 *
 */
readers.readDataSync = function (path, opts_) {
  var parser
  var parseWith
  if (arguments.length === 2) {
    parseWith = opts_.parseWith || opts_.parser
    parser = getDelimiterOrParser(parseWith)
  } else {
    parser = helpers.discernParser(path)
  }
  var data = fs.readFileSync(path, 'utf8')
  if (helpers.discernFormat(path) === 'json' && data === '') {
    data = '[]'
  }

  var parsed
  if (_.isFunction(parser)) {
    parsed = parser(data)
  } else if (_.isObject(parser.parse) && _.isFunction(parser.parse)) {
    parsed = parser.parse(data)
  } else {
    return new Error('Your specified parser is not properly formatted. It must either be a function or have a `parse` method.')
  }

  // if (opts_ && opts_.flatten) {
  //   parsed = _.map(parsed, flatten)
  // }
  return parsed
}

/**
 * Get a list of a directory's files and folders if certain critera are met.
 *
 * @param {String} dirPath The directory to read from
 * @param {Object} options Filter options, see below
 * @param {String|RegExp|Array<String>|Array<RegExp>} options.include If given a string, return files that have that string as their extension. If given a Regular Expression, return the file that matches the pattern. Can also take a list of both. List matching behavior is described in `includeAll`.
 * @param {String|RegExp|Array<String>|Array<RegExp>} options.exclude If given a string, return files that do not have that string as their extension. If given a Regular Expression, return the file that matches the pattern. Can also take a list of both. List matching behavior is described in `excludeAll`.
 * @param {Boolean} [options.includeMatchAll=false] If true, require all include conditions to be met for a file to be included.
 * @param {Boolean} [options.excludeMatchAll=false] If true, require all exclude conditions to be met for a file to be excluded.
 * @param {Boolean} [options.fullPath=false] If `true` the full path of the file, otherwise return just the file name.
 * @param {Boolean} [options.skipFiles=false] If `true`, only include directories.
 * @param {Boolean} [options.skipDirectories=false] If `true`, only include files.
 * @param {Function} callback Callback fired with signature of `(err, files)` where `files` is a list of matching file names.
 *
 * @example
 * // dir contains `data-0.tsv`, `data-0.json`, `data-0.csv`, `data-1.csv`, `.hidden-file`
 * io.readdirFilter('path/to/files', {include: 'csv'}, function(err, files){
 *   console.log(files) // ['data-0.csv', 'data-1.csv']
 * })
 *
 * io.readdirFilter('path/to/files', {include: [/^data/], exclude: ['csv', 'json']}, , function(err, files){
 *   console.log(files) // ['path/to/files/data-0.csv', 'path/to/files/data-1.csv', 'path/to/files/data-0.tsv']
 * })
 *
 */
readers.readdirFilter = function (dirPath, opts_, cb) {
  if (typeof cb === 'undefined') {
    cb = opts_
    opts_ = undefined
  }

  readdir({async: true}, dirPath, opts_, cb)
}

/**
 * Synchronously get a list of a directory's files and folders if certain critera are met.
 *
 * @param {String} dirPath The directory to read from
 * @param {Object} options filter options, see below
 * @param {String|RegExp|Array<String>|Array<RegExp>} options.include if given a string, return files that have that string as their extension. If given a Regular Expression, return the file that matches the pattern. Can also take a list of both. List matching behavior is described in `includeAll`.
 * @param {String|RegExp|Array<String>|Array<RegExp>} options.exclude if given a string, return files that do not have that string as their extension. If given a Regular Expression, return the file that matches the pattern. Can also take a list of both. List matching behavior is described in `excludeAll`.
 * @param {Boolean} [options.includeMatchAll=false] If true, require all include conditions to be met for a file to be included.
 * @param {Boolean} [options.excludeMatchAll=false] If true, require all exclude conditions to be met for a file to be excluded.
 * @param {Boolean} [options.fullPath=false] If `true` the full path of the file, otherwise return just the file name.
 * @param {Boolean} [options.skipFiles=false] If `true`, only include directories.
 * @param {Boolean} [options.skipDirectories=false] If `true`, only include files.
 * @returns {Array<String>} The matching file names
 *
 * @example
 * // dir contains `data-0.tsv`, `data-0.json`, `data-0.csv`, `data-1.csv`, `.hidden-file`
 * var files = io.readdirFilterSync('path/to/files', {include: 'csv'})
 * console.log(files) // ['data-0.csv', 'data-1.csv']
 *
 * var files = io.readdirFilterSync('path/to/files', {include: [/^data/], exclude: 'json', fullPath: true})
 * console.log(files) // ['path/to/files/data-0.csv', 'path/to/files/data-1.csv', 'path/to/files/data-0.tsv']
 *
 * var files = io.readdirFilterSync('path/to/files', {include: [/^data/, 'json'], fullPath: true, includeMatchAll: true})
 * console.log(files) // ['path/to/files/data-0.json', 'path/to/files/data-1.json']
 *
 */
readers.readdirFilterSync = function (dirPath, opts_) {
  return readdir({async: false}, dirPath, opts_)
}

/**
  * Convenience functions to load in a file with a specific type. This is equivalent to using `readData` and specifying a parser.
  * @namespace
*/
var shorthandReaders = {}

/**
 * Asynchronously read a comma-separated value file.
 *
 * @param {String} fileName the name of the file
 * @param {Function} callback callback used when read data is read, takes error (if any) and the data read
 *
 * @example
 * io.readCsv('path/to/data.csv', function(err, data){
 *   console.log(data) // Json data
 * })
 *
 */
shorthandReaders.readCsv = function (path, cb) {
  readers.readData(path, {parser: parsers.csv}, cb)
}

/**
 * Synchronously read a comma-separated value file.
 *
 * @param {String} fileName the name of the file
 * @returns {Array} the contents of the file as JSON
 *
 * @example
 * var data = io.readCsvSync('path/to/data.csv')
 * console.log(data) // Json data
 *
 */
shorthandReaders.readCsvSync = function (path) {
  return readers.readDataSync(path, {parser: parsers.csv})
}

/**
 * Asynchronously read a JSON file.
 *
 * @param {String} fileName the name of the file
 * @param {Function} callback callback used when read data is read, takes error (if any) and the data read
 *
 * @example
 * io.readJson('path/to/data.json', function(err, data){
 *   console.log(data) // Json data
 * })
 *
 */
shorthandReaders.readJson = function (path, cb) {
  readers.readData(path, {parser: parsers.json}, cb)
}

/**
 * Synchronously read a JSON file.
 *
 * @param {String} fileName the name of the file
 * @returns {Array} the contents of the file as JSON
 *
 * @example
 * var data = io.readJsonSync('path/to/data.json')
 * console.log(data) // Json data
 *
 */
shorthandReaders.readJsonSync = function (path) {
  return readers.readDataSync(path, {parser: parsers.json})
}

/**
 * Asynchronously read a tab-separated value file.
 *
 * @param {String} fileName the name of the file
 * @param {Function} callback callback used when read data is read, takes error (if any) and the data read
 *
 * @example
 * io.readTsv('path/to/data.tsv', function(err, data){
 *   console.log(data) // Json data
 * })
 *
 */
shorthandReaders.readTsv = function (path, cb) {
  readers.readData(path, {parser: parsers.tsv}, cb)
}

/**
 * Synchronously read a tab-separated value file.
 *
 * @param {String} fileName the name of the file
 * @returns {Array} the contents of the file as JSON
 *
 * @example
 * var data = io.readTsvSync('path/to/data.tsv')
 * console.log(data) // Json data
 *
 */
shorthandReaders.readTsvSync = function (path) {
  return readers.readDataSync(path, {parser: parsers.tsv})
}

/**
 * Asynchronously read a pipe-separated value file.
 *
 * @param {String} fileName the name of the file
 * @param {Function} callback callback used when read data is read, takes error (if any) and the data read
 *
 * @example
 * io.readPsv('path/to/data.psv', function(err, data){
 *   console.log(data) // Json data
 * })
 *
 */
shorthandReaders.readPsv = function (path, cb) {
  readers.readData(path, {parser: parsers.psv}, cb)
}

/**
 * Synchronously read a pipe-separated value file.
 *
 * @param {String} fileName the name of the file
 * @returns {Array} the contents of the file as JSON
 *
 * @example
 * var data = io.readPsvSync('path/to/data.psv')
 * console.log(data) // Json data
 *
 */
shorthandReaders.readPsvSync = function (path) {
  return readers.readDataSync(path, {parser: parsers.psv})
}

/**
 * Asynchronously read a text file.
 *
 * @param {String} fileName the name of the file
 * @param {Function} callback callback used when read data is read, takes error (if any) and the data read
 *
 * @example
 * io.readTxt('path/to/data.txt', function(err, data){
 *   console.log(data) // string data
 * })
 *
 */
shorthandReaders.readTxt = function (path, cb) {
  readers.readData(path, {parser: parsers.txt}, cb)
}

/**
 * Synchronously read a text file.
 *
 * @param {String} fileName the name of the file
 * @returns {Array} the contents of the file as a string
 *
 * @example
 * var data = io.readTxtSync('path/to/data.txt')
 * console.log(data) // string data
 *
 */
shorthandReaders.readTxtSync = function (path) {
  return readers.readDataSync(path, {parser: parsers.txt})
}

/**
 * Asynchronously read a yaml file. Note: uses js-yaml's `.load` method, which has no security checking for functions. Use the js-yaml library if you require stricter security.
 *
 * @param {String} fileName the name of the file
 * @param {Function} callback callback used when read data is read, takes error (if any) and the data read
 *
 * @example
 * // Can be `.yaml` or `.yml` extension
 * io.readYaml('path/to/data.yaml', function(err, data){
 *   console.log(data) // json data
 * })
 *
 */
shorthandReaders.readYaml = function (path, cb) {
  readers.readData(path, {parser: parsers.yaml}, cb)
}

/**
 * Synchronously read a yaml file. Note: uses js-yaml's `.load` method, which has no security checking for functions. Use the js-yaml library if you require stricter security.
 *
 * @param {String} fileName the name of the file
 * @returns {Array} the contents of the file as a string
 *
 * @example
 * // Can be `.yaml` or `.yml` extension
 * var data = io.readYamlSync('path/to/data.yaml')
 * console.log(data) // json data
 *
 */
shorthandReaders.readYamlSync = function (path) {
  return readers.readDataSync(path, {parser: parsers.yaml})
}

/**
 * Asynchronously read an ArchieMl file.
 *
 * @param {String} fileName the name of the file
 * @param {Function} callback callback used when read data is read, takes error (if any) and the data read
 *
 * @example
 * io.readAml('path/to/data.aml', function(err, data){
 *   console.log(data) // json data
 * })
 *
 */
shorthandReaders.readAml = function (path, cb) {
  readers.readData(path, {parser: parsers.aml}, cb)
}

/**
 * Synchronously read an ArchieML file.
 *
 * @param {String} fileName the name of the file
 * @returns {Object} the contents of the file as a string
 *
 * @example
 * var data = io.readAmlSync('path/to/data.aml')
 * console.log(data) // json data
 *
 */
shorthandReaders.readAmlSync = function (path) {
  return readers.readDataSync(path, {parser: parsers.aml})
}

/**
 * Asynchronously read a dbf file.
 *
 * @param {String} fileName the name of the file
 * @param {Function} callback callback used when read data is read, takes error (if any) and the data read
 *
 * @example
 * io.readDbf('path/to/data.dbf', function(err, data){
 *   console.log(data) // Json data
 * })
 *
 */
readers.readDbf = function (path, cb) {
  var reader = shapefileDbf.reader(path)
  var rows = []
  var headers

  // Run these in order
  queue(1)
    .defer(readHeader)
    .defer(readAllRecords)
    .defer(close)
    .await(function (error, readHeaderData, readAllRecordsData, jsonData) {
      // We're using queue to work through this flow
      // As a result, `readHeaderData`, `readAllRecordsData` are going to be undefined
      // Because they aren't meant to return anything, just process data
      // `rowData`, however contains all our concatenated data, so let's return that
      cb(error, jsonData)
    })

  function readHeader (callback) {
    reader.readHeader(function (error, header) {
      if (error) {
        return callback(error)
      }
      headers = header.fields.map(function (d) {
        return d.name
      })
      callback(null)
    })
  }

  function readAllRecords (callback) {
    (function readRecord () {
      reader.readRecord(function (error, record) {
        if (error) {
          return callback(error)
        }
        if (record === shapefileDbf.end) {
          return callback(null)
        }
        var jsonRecord = _.object(headers, record)
        rows.push(jsonRecord)
        process.nextTick(readRecord)
      })
    })()
  }

  function close (callback) {
    reader.close(function (error) {
      if (error) {
        return callback(error)
      }
      callback(null, rows)
    })
  }

}

// Used internally by `readdir` functions to make more DRY
function readdir (modeInfo, dirPath, opts_, cb) {
  opts_ = opts_ || {}
  var isAsync = modeInfo.async

  // Convert to array if a string
  opts_.include = strToArray(opts_.include)
  opts_.exclude = strToArray(opts_.exclude)

  // Set defaults if not provided
  opts_.includeMatchAll = (opts_.includeMatchAll) ? 'every' : 'some'
  opts_.excludeMatchAll = (opts_.excludeMatchAll) ? 'every' : 'some'

  if (isAsync === true) {
    fs.readdir(dirPath, function (err, files) {
      if (err) {
        throw err
      }
      filter(files, cb)
    })
  } else {
    return filterSync(fs.readdirSync(dirPath))
  }

  function strToArray (val) {
    if (val && !_.isArray(val)) {
      val = [val]
    }
    return val
  }

  function filterByType (file, cb) {
    var filePath = (opts_.fullPath) ? file : path.join(dirPath, file)
    if (isAsync === true) {
      fs.stat(filePath, function (err, stats) {
        var filtered = getFiltered(stats.isDirectory())
        cb(err, filtered)
      })
    } else {
      return getFiltered(fs.statSync(filePath).isDirectory())
    }

    function getFiltered (isDir) {
      if (opts_.skipDirectories) {
        if (isDir) {
          return false
        }
      }
      if (opts_.skipFiles) {
        if (!isDir) {
          return false
        }
      }
      return file
    }

  }

  function filterByMatchers (files) {

    var filtered = files.filter(function (fileName) {
      var isExcluded
      var isIncluded

      // Don't include if matches exclusion matcher
      if (opts_.exclude) {
        isExcluded = opts_.exclude[opts_.excludeMatchAll](function (matcher) {
          return helpers.matches(fileName, matcher)
        })
        if (isExcluded === true) {
          return false
        }
      }

      // Include if matches inclusion matcher, exclude if it doesn't
      if (opts_.include) {
        isIncluded = opts_.include[opts_.includeMatchAll](function (matcher) {
          return helpers.matches(fileName, matcher)
        })
        return isIncluded
      }

      // Return true if it makes it to here
      return true

    })

    // Prefix with the full path if that's what we asked for
    if (opts_.fullPath === true) {
      filtered = filtered.map(function (fileName) {
        return path.join(dirPath, fileName)
      })
    }

    return filtered

  }

  function filterSync (files) {

    var filtered = filterByMatchers(files)

    return filtered.map(function (file) {
      return filterByType(file)
    }).filter(_.identity)
  }

  function filter (files, cb) {
    var filterQ = queue()

    var filtered = filterByMatchers(files)

    filtered.forEach(function (fileName) {
      filterQ.defer(filterByType, fileName)
    })

    filterQ.awaitAll(function (err, namesOfType) {
      cb(err, namesOfType.filter(_.identity))
    })

  }

}

/**
  * Functions to write data files.
  * @namespace
*/
var writers = {}

/**
 * Write the data object, inferring the file format from the file ending specified in `fileName`.
 *
 * Supported formats:
 *
 * * `.json` Array of objects
 * * `.csv` Comma-separated
 * * `.tsv` Tab-separated
 * * `.psv` Pipe-separated
 * * `.yaml` Yaml file
 * * `.yml` Yaml file
 * * `.dbf` Database file, commonly used in ESRI-shapefile format.
 *
 * *Note: `.yaml` and `.yml` files are written with `.dump`, which has no security checking. See `js-yaml` for more secure optins.*
 *
 * @param {String} fileName the name of the file
 * @param {Object} data the data to write
 * @param {Object} [options] Optional config object, see below
 * @param {Boolean} [options.makeDirectories=false] If true, create intermediate directories to your data file.
 * @param {Function} callback callback of `(err, data)` where `err` is any error and `data` is the data that was written out
 *
 * @example
 * io.writeData('path/to/data.json', jsonData, function(err){
 *   console.log(err)
 * })
 *
 * io.writeData('path/to/create/to/data.csv', flatJsonData, {makeDirectories: true}, function(err){
 *   console.log(err)
 * })
 */
writers.writeData = function (outPath, data, opts_, cb) {
  if (typeof cb === 'undefined') {
    cb = opts_
  }
  if (!data) {
    reporters.warn('You didn\'t pass any data to write for file: ' + chalk.bold(outPath) + ' Writing out an empty file...')
  }

  if (_.isObject(opts_) && opts_.makeDirectories) {
    helpers.makeDirectories(outPath, proceed)
  } else {
    proceed()
  }

  function proceed (err) {
    if (err) {
      throw err
    }
    var fileFormatter = helpers.discernFileFormatter(outPath)
    fs.writeFile(outPath, fileFormatter(data), function (err) {
      cb(err, data)
    })

  }
}

/**
 * Syncronous version of {@link writers#writeData}
 *
 * @param {String} fileName the name of the file
 * @param {Object} [options] Optional config object, see below
 * @param {Boolean} [options.makeDirectories=false] If true, create intermediate directories to your data file.
 * @param {Object} data the data to write
 * @returns {Object} the data that was written
 *
 * @example
 * io.writeDataSync('path/to/data.json', jsonData)
 *
 * io.writeDataSync('path/to/create/to/data.csv', flatJsonData, {makeDirectories: true})
 *
 */
writers.writeDataSync = function (outPath, data, opts_) {
  if (_.isEmpty(data)) {
    reporters.warn('You didn\'t pass any data to write for file: ' + chalk.bold(outPath) + ' Writing out an empty file...')
  }
  if (opts_ && opts_.makeDirectories) {
    helpers.makeDirectoriesSync(outPath)
  }
  var fileFormatter = helpers.discernFileFormatter(outPath)
  fs.writeFileSync(outPath, fileFormatter(data))
  return data
}

/**
 * Append to an existing data object, creating a new file if one does not exist. For tabular formats, data must be an array of flat objects (cannot contain nested objects or arrays).
 *
 * Supported formats:
 *
 * * `.json` Array of objects
 * * `.csv` Comma-separated
 * * `.tsv` Tab-separated
 * * `.psv` Pipe-separated
 * * `.yaml` or `.yml` Yaml
 *
 * *Note: Does not currently support .dbf files.*
 *
 * @param {String} fileName the name of the file
 * @param {Object} data the data to write
 * @param {Object} [options] Optional config object, see below
 * @param {Boolean} [options.makeDirectories=false] If true, create intermediate directories to your data file.
 * @param {Function} callback callback of `(err, data)` where `err` is any error and `data` is the data that was written out
 *
 * @example
 * io.writeAppendData('path/to/data.json', jsonData, function(err){
 *   console.log(err)
 * })
 *
 * io.writeAppendData('path/to/create/to/data.csv', flatJsonData, {makeDirectories: true}, function(err){
 *   console.log(err)
 * })
 */
writers.appendData = function (outPath, data, opts_, cb) {
  if (typeof cb === 'undefined') {
    cb = opts_
  }
  if (_.isObject(opts_) && opts_.makeDirectories) {
    helpers.makeDirectories(outPath, proceed)
  } else {
    proceed()
  }
  function proceed (err) {
    if (err) {
      throw err
    }
    // Run append file to delegate creating a new file if none exists
    fs.appendFile(outPath, '', function (err) {
      if (!err) {
        readers.readData(outPath, function (err, existingData) {
          if (!err) {
            data = existingData.concat(data)
            writers.writeData(outPath, data, opts_, cb)
          } else {
            cb(err)
          }
        })
      } else {
        cb(err)
      }
    })

  }
}

/**
 * Synchronous version of {@link writers#appendData}. See that function for supported formats
 *
 * @param {String} fileName the name of the file
 * @param {Object} [options] Optional config object, see below
 * @param {Boolean} [options.makeDirectories=false] If true, create intermediate directories to your data file.
 * @param {Object} data the data to write
 * @returns {Object} the data that was written
 *
 * @example
 * io.writeAppendDataSync('path/to/data.json', jsonData)
 *
 * io.writeAppendDataSync('path/to/create/to/data.csv', flatJsonData, {makeDirectories: true})
 */
writers.appendDataSync = function (outPath, data, opts_) {
  // Run append file to delegate creating a new file if none exists
  if (opts_ && opts_.makeDirectories) {
    helpers.makeDirectoriesSync(outPath)
  }
  fs.appendFileSync(outPath, '')
  var existingData = readers.readDataSync(outPath)
  data = existingData.concat(data)
  writers.writeDataSync(outPath, data, opts_)
  return data
}

/**
  * Functions that both read and write.
  * @namespace
*/
var converters = {}

/**
 * Reads in a dbf file with `.readDbf` and write to file using `.writeData`. A convenience function for converting DBFs to more useable formats. Formerly known as `writeDbfToData` and is aliased for legacy support.
 *
 * @param {String} inFileName the input file name
 * @param {String} outFileName the output file name
 * @param {Object} [options] Optional config object, see below
 * @param {Boolean} [options.makeDirectories=false] If true, create intermediate directories to your data file.
 * @param {Function} callback callback that takes error (if any)
 *
 * @example
 * io.convertDbfToData('path/to/data.dbf', 'path/to/data.csv', function(err){
 *   console.log(err)
 * })
 *
 * io.convertDbfToData('path/to/data.dbf', 'path/to/create/to/data.csv', {makeDirectories: true}, function(err){
 *   console.log(err)
 * })
 */
converters.convertDbfToData = function (inPath, outPath, opts_, cb) {
  if (typeof cb === 'undefined') {
    cb = opts_
  }
  readers.readDbf(inPath, function (error, jsonData) {
    if (error) {
      cb(error)
    } else {
      writers.writeData(outPath, jsonData, opts_, cb)
    }
  })
}

// Alias this function to `writers.writeDbfToData` for legacy support
writers.writeDbfToData = converters.convertDbfToData

module.exports = _.extend({}, readers, shorthandReaders, writers, converters, helpers, { fs: fs })
