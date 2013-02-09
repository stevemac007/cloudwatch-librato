var fs = require('fs');
var path = require('path');
var exec = require('child_process').exec;
var Step = require('step');
var aws = require('aws-lib');
var _ = require('underscore');

var optimist = require('optimist')
.usage('Poll the AWS CloudWatch service and dispatch the resultant metrics to librato.\n' +
       'Usage: $0 [options]\n\n' +
       '  http://aws.amazon.com/cloudwatch/ \n' +
       '  http://librato.com/')
.alias('region', 'r')
.alias('config', 'c')
.describe('config', 'location of the metrics definition file')
.default('debug', false)
.describe('debug', 'debug data structures')
.default('region', 'ap-southeast-2')
.describe('region', 'default region')
.demand('config');

var argv = optimist.argv;
process.title = 'cloudwatch-librato';

var options = {};

// Setup configuration options
if (argv.config) {
    try {
        _(JSON.parse(fs.readFileSync(argv.config, 'utf8'))).each(function(v, k) {
            options[k] = v;
        });
    } catch(e) {
        console.warn('Invalid JSON config file: ' + argv.config);
       throw e;
    }
}

if (argv.region) {
    options["region"] = argv.region;
}

// Allow options command-line overrides
_.each(argv, function(v, k) {
    options[k] = argv[k];
});

Step(

    function(err, stdout, stderr) {
        
        if (err) throw err;
        console.info('Default Region ' + options.region);
        
        console.info('Resolving Metric dimensions.');
        var group = this.group();
        _(options.metrics).each(function(metric, i) {
            if (options.debug) 
                console.info('\n Metric: ' + metric.MetricName);
            
            if (metric.Dimensions === '_self') {
                options.metrics[i].Dimensions = {};
                options.metrics[i].Dimensions[resolveSelfRegion()] = '';
                resolveSelf(group());
            } else {
                for (region in metric.Dimensions) {
                    if (options.debug) 
                        console.info('  Region: ' + region);
                        
                    if (metric.Dimensions[region] === "_callback") {
                        exec(path.join(__dirname, './getInstances ') + region, group());
                    }
                }
            }
        });
    },
    
    function(err, stdout, stderr) {
        
        if (err) throw err;
        var tags = {};
        var instanceMap = [];    
        _(stdout).each(function(string) {
            instanceMap.push(string.replace('\n', '').split(' '));
        });
        
        // Get list of referenced regions
        var regions = _(options.metrics).chain()
            .map(function(metric) {
                return _(metric.Dimensions).keys()
            })
            .flatten()
            .unique()
            .value();

        // Set regions in options
        options.regions = regions;
        
        // Try to get human name of dimension, like the instance name, from ec2 tags API
        getTags(regions, function(err, res) {
            if (err) throw err;
            _(regions).each(function(region, i) {
                tags[region] = Array.isArray(res[i].tagSet.item) ?
                  res[i].tagSet.item : [res[i].tagSet.item];
            });
            
            // Index of instanceMap, which differs from number of metrics due to
            // not all metrics are instance-centric, such as ELB request count
            var z = 0;
            _(options.metrics).each(function(metric, i) {
                for (region in metric.Dimensions) {

                    // If there are no dimension values for a given region
                    // map them in from the instancemap
                    if (!Array.isArray(options.metrics[i].Dimensions[region])) {
                        options.metrics[i].Dimensions[region] = [];
                        _(instanceMap[z]).each(function(instance) {
                            var name = _(tags[region]).find(function(tag) {
                                return tag.resourceId === instance;
                            });
                            if (name) name = (name.value).replace(/(-|\s)/g,'_');
                            else name = '';
                            options.metrics[i].Dimensions[region].push([instance, name]);
                        });
                        z++;
                    }
                }
            });

            var Metrics = require('./lib/Metrics.js')(options);
            
            // Batch by metric period to consolidate requests made to Librato API
            var batches = _(options.metrics).groupBy(function(metric) {
                return parseInt(metric.Period, 10);
            });

            // *************************
            // You can enable this to debug what requests batches were determined
            if (options.debug)
                console.log("batches: %s", JSON.stringify(batches, null, 4));
            // *************************
           
            _(batches).each(function(batch) {
                var reporter = new Metrics(batch);
            }); 
        });
    }
);

function resolveSelfRegion() {

    if (options.selfRegion == undefined) {
        exec('wget -q -O - http://169.254.169.254/latest/meta-data/placement/availability-zone',  
            function(err, stdout, stderr) {
                log.info("stdout: "+ stdout);
                if (err) throw err;
                options.selfRegion = stdout.slice(0,-1);
            }
        );
    }
    
    console.info("Self Region resolved to "+ options.selfRegion);
    
    return options.selfRegion;
}

/**
 * Adaptive self resolve logic that checks if there is a './self' command first
 * if not falls back to retreiving the value from the local AWS instance-id
 */
function resolveSelf(cb) {

    filename = path.join(__dirname, './self ');
    
    if (path.existsSync(filename)) { 
        console.log("execing %f", filename);
        exec(filename, cb);
    }
    else {
        console.log("execing direct lookup");
        exec('wget -q -O - http://169.254.169.254/latest/meta-data/instance-id', cb);  
    }
}

function getTags(regions, cb) {
    var clients = {};
    _(regions).each(function(region) {
        clients[region] = aws.createEC2Client(options.awskey, options.awssecret, 
          {version: '2012-03-01', host: 'ec2.' + region + '.amazonaws.com'});
    });
    Step(
        function() {
            var group = this.group();
            _(regions).each(function(region) {
                clients[region].call('DescribeTags', {
                    'Filter.1.Name': 'key',
                    'Filter.1.Value': options.instanceNameTag,
                    'Filter.2.Name': 'resource-type',
                    'Filter.2.Value': 'instance'
                }, group());
            });
        },
        function(err, tags) {
            if (err) throw err;
            cb(err, tags);
        }
    );
}
