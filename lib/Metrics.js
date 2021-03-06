var aws = require('aws-lib');
var Step = require('step');
var _ = require('underscore');
var Librato = require('librato-metrics');

module.exports = function(options) {
    var clients = {};
    _(options.regions).each(function(region) {
        clients[region] = aws.createCWClient(options.awskey, options.awssecret,
          {host: 'monitoring.' + region + '.amazonaws.com'});
    });

    var librato = Librato.createClient({
        email: options.libratoemail,
        token: options.libratotoken
    });

    var Metrics = function(batch) {
        var that = this;

        console.info("Scheduled for %s seconds interval processing.... ", batch[0].Period);
        setInterval(function() {
            console.info("Interval ");
            that.fetch(batch, function(err, results) {
                if (err) console.error('Batch fetch of CloudWatch metrics failed. Error: %s', err);
                else that.submit(batch, results);
            });
        }, parseInt(batch[0].Period, 10) * 1000);
    };

    Metrics.prototype.fetch = function(batch, cb) {
        Step(
            function() {
                console.log("****************************************");
                console.log("*  Retreiving metrics from CloudWatch  *");
                console.log("****************************************");

                var group = this.group();
                _(batch).each(function(metric) {
                    _(metric.Dimensions).each(function(devices, region) {
                        _(devices).each(function(device) {
                            var params = {
                                MetricName: metric.MetricName,
                                Namespace: metric.Namespace,
                                'StartTime': new Date(new Date().getTime() - (metric.Period * 2e3)).toISOString(),
                                'EndTime': new Date(new Date().getTime() - (metric.Period * 1e3)).toISOString(),
                                'Period': metric.Period,
                                'Unit': metric.Unit,
                                'Statistics.member.1': metric.Statistic
                            };

                            if (device) {
                                if (device[0] === 'BLANK') {

                                } else if (device[0].substring(0,2) === 'i-') {
                                    params['Dimensions.member.1.Name'] = 'InstanceId';
                                    params['Dimensions.member.1.Value'] = device[0];
                                } else {
                                	params['Dimensions.member.1.Name'] = device[0];
                                	params['Dimensions.member.1.Value'] = device[1];
                                }
                            }
                            
                            // *************************
                            // You can enable this to debug what requests are being sent to AWS
                            // console.info("\nGetMetricStatistics [%s]: %j", region, params);
                            // *************************

                            clients[region].call('GetMetricStatistics', params, group());
                        });
                    });
                });
             },
             function(err, results) {
                 if (err) return cb(err);
                 cb(null, results);
             }
        );
    }

    Metrics.prototype.submit = function(batch, results) {
        var payload = [];
        var z = 0;
        var y = 0;
        
        // *************************
        // You can enable this to debug what requests are being sent to AWS
        // console.info("\n\nResults : "+ JSON.stringify(results, null, 4));
        // *************************
        
        _(batch).each(function(metric) {
            _(metric.Dimensions).each(function(devices, region) {

                _(devices).each(function(device) {

                    var error = results[z].Error;
                    if (error) {
                        console.error("%s\n   %s", error.Code, error.Message);
                    }
                    else {
                        var data = results[z].GetMetricStatisticsResult.Datapoints.member;
                        if (data) {
                            payload[y] = {
                                name: results[z].GetMetricStatisticsResult.Label,
                                value: data[metric.Statistic],
                                source: device[2] || device[1],
                                measure_time: new Date(data.Timestamp).getTime() / 1000
                            };
                            
                            console.info("%s for %j [%j %s]", results[z].GetMetricStatisticsResult.Label, device, payload[y].value, data.Unit);

                            y++;
                        }
                        else {
                            console.info("%s for %j [No Result]", results[z].GetMetricStatisticsResult.Label, device);
                        }
                    }
                    z++;
                });

            });
        });

        console.log("\n\n****************************************");
        console.log("*    Processing and sending results    *");
        console.log("****************************************");

        if (payload[0]) {
            console.info (" POST to librato %s", JSON.stringify(payload, null, 4));
            librato.post('/metrics', {
                gauges: payload
            }, function(err, response) {
               if (err) console.error('Submission to Librato failed.  Error %s', err);
            });
        }
    }

    return Metrics;
}
