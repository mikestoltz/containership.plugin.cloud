'use strict';

const github = require('./integrations/github');
const prmpt = require('prompt');
const colors = require('colors');

var fs = require("fs");
var _ = require("lodash");
var async = require("async");
var providers = require([__dirname, "providers", "index"].join("/"));
var read = require("read");
var request = require("request");
var sprintf = require("sprintf-js").sprintf;
var tar = require("tar-fs");
var child_process = require("child_process");
var glob = require("glob");

module.exports = {

    login: {
        options: {
            method: {
                position: 1,
                help: 'Signin method',
                metavar: 'METHOD',
                required: true,
                choices: ['github']
            }
        },

        callback: function(options){
            prmpt.message = '';
            prmpt.delimiter = colors.white(':');
            prmpt.start();

            function get_credentials(callback) {
                prmpt.get([{
                    name: 'username',
                    description: colors.white('Username'),
                    required: true
                }, {
                    name: 'password',
                    description: colors.white('Password'),
                    hidden: true
                }], callback);
            }

            function get_otp(callback) {
                prmpt.get([{
                    name: 'otp',
                    description: colors.white('Authentication Code'),
                    required: true
                }], callback);
            }

            function authenticate(auth, callback) {
                const request_options = {
                    url: 'https://auth.containership.io/v1/authenticate/github/authorization',
                    method: 'POST',
                    json: {
                        authorization: auth.token
                    }
                }

                request(request_options, (err, response) => {
                    if (err || response.statusCode != 201) {
                        return callback(new Error('Error generating ContainerShip auth token'))
                    } else {
                        config.load();

                        if (_.isUndefined(config.config.headers)) {
                            config.config.headers = {};
                        }

                        config.config.headers.authorization = `Bearer ${response.body.token}`;
                        if (response.body.organization) {
                            config.config.headers['x-containership-cloud-organization'] = response.body.organization.id;
                        }

                        config.set(config.config);
                        return callback();
                    }
                });
            }

            get_credentials((err, credentials) => {
                if (err) {
                    process.stderr.write(`${err.message}\n`);
                    process.exit(1);
                }

                function github_authorize(otp, callback) {
                    if (_.isFunction(otp)) {
                        callback = otp;
                        otp = undefined;
                    }

                    github.authorize(otp, callback);
                }

                github.authenticate(credentials);

                github.get_user((err, user) => {
                    if (err && err.headers && err.headers['x-github-otp']) {
                        get_otp((err, credentials) => {
                            if (err) {
                                process.stderr.write(`${err.message}\n`);
                                process.exit(1);
                            }

                            github_authorize(credentials.otp, (err, auth) => {
                                if (err) {
                                    process.stderr.write(`${err.message}\n`);
                                    process.exit(1);
                                }

                                authenticate(auth, (err) => {
                                    if (err) {
                                        process.stderr.write(`${err.message}\n`);
                                        process.exit(1);
                                    } else {
                                        process.stdout.write(colors.green('\nSuccessfully logged in!\n'));
                                    }
                                });
                            });
                        });
                    } else if (err) {
                        process.stderr.write(`${err.message}\n`);
                        process.exit(1);
                    } else {
                        github_authorize((err, auth) => {
                            if (err) {
                                process.stderr.write(`${err.message}\n`);
                                process.exit(1);
                            }

                            authenticate(auth, (err) => {
                                if (err) {
                                    process.stderr.write(`${err.message}\n`);
                                    process.exit(1);
                                } else {
                                    process.stdout.write(colors.green('\nSuccessfully logged in!\n'));
                                }
                            });
                        });
                    }
                });
            });
        }
    },

    logout: {
        options: {},
        callback: function(options){
            config.load();
            delete config.config.headers["authorization"];
            delete config.config.headers["x-containership-cloud-organization"];
            delete config.config.headers["x-containership-cloud-cluster"];
            config.set(config.config);
            console.log("Successfully logged out!");
        }
    },

    "list-orgs": {
        options: {},
        callback: function(options){
            config.load();

            var request_options = {
                url: [
                    "https://api.containership.io",
                    "v2",
                    "account"
                ].join("/"),
                method: "GET",
                json: true,
                headers: _.pick(config.config.headers, "authorization")
            }

            request(request_options, function(err, response){
                if(err || response.statusCode != 200){
                    process.stderr.write("Could not fetch organizations!");
                    process.exit(1);
                }

                var orgs = {};

                async.each(response.body.organizations || [], function(organization, fn){
                    var request_options = {
                        url: [
                            "https://api.containership.io",
                            "v2",
                            "organizations",
                            organization
                        ].join("/"),
                        method: "GET",
                        json: true,
                        headers: _.pick(config.config.headers, "authorization")
                    }
                    request(request_options, function(err, response){
                        if(err || response.statusCode != 200)
                            return fn();
                        else{
                            orgs[organization] = {
                                owner: response.body.owner,
                                description: response.body.description || organization
                            }
                            return fn();
                        }
                    });
                }, function(err){
                    console.log(sprintf("%-50s %-50s %-50s",
                        "ID",
                        "ORGANIZATION",
                        "OWNER"
                    ));

                    _.each(orgs, function(org_details, org){
                        console.log(sprintf("%-50s %-50s %-50s",
                            [org, config.config.headers["x-containership-cloud-organization"] == org ? "*" : ""].join(""),
                            org_details.description,
                            org_details.owner
                        ));
                    });
                });
            });
        }
    },

    "use-org": {
        options: {
            organization: {
                position: 1,
                help: "ContainerShip organization to use",
                metavar: "ORGANIZATION",
                required: true
            }
        },
        callback: function(options){
            config.load();

            var request_options = {
                url: [
                    "https://api.containership.io",
                    "v2",
                    "account"
                ].join("/"),
                method: "GET",
                json: true,
                headers: _.pick(config.config.headers, "authorization")
            }

            request(request_options, function(err, response){
                if(err || response.statusCode != 200){
                    process.stderr.write("Could not fetch organizations!");
                    process.exit(1);
                }

                if(_.contains(response.body.organizations, options.organization)){
                    config.config.headers["x-containership-cloud-organization"] = options.organization;
                    config.set(config.config);
                    console.log(["Successfully switched to", options.organization, "organization!"].join(" "));
                }
                else{
                    process.stderr.write(["You do not belong to the", options.organization, "organization!"].join(" "));
                    process.exit(1);
                }
            });
        }
    },

    "create-cluster": {
        options: {
            provider: {
                position: 1,
                help: "Provider on which to launch the cluster",
                metavar: "PROVIDER",
                required: true,
                choices: ["vagrant"]
            },

            leaders: {
                help: "Number of leaders to create",
                metavar: "LEADERS",
                default: 1
            },
            followers: {
                help: "Number of followers to create",
                metavar: "FOLLOWERS",
                default: 2
            },
            plugins: {
                help: "List of ContainerShip plugins to install",
                metavar: "PLUGINS",
                default: "navigator,service-discovery"
            }
        },

        callback: function(options){
            var provider = providers[options.provider];

            provider.validate(function(err){
                if(err)
                    throw err;

                provider.create({
                    leaders: options.leaders,
                    followers: options.followers,
                    plugins: options.plugins
                }, function(err){
                    if(err)
                        throw err;
                });
            });
        }
    },

    "destroy-cluster": {
        options: {
            "cluster-id": {
                position: 1,
                help: "ID of the cluster to destroy",
                metavar: "CLUSTER_ID",
                required: true
            },
        },

        callback: function(options){
            config.load();

            providers.vagrant.get_clusters(function(err, clusters){
                var request_options = {
                    url: [
                        "https://api.containership.io",
                        "v2",
                        "organizations",
                        config.config.headers["x-containership-cloud-organization"],
                        "clusters"
                    ].join("/"),
                    method: "GET",
                    json: true,
                    headers: _.pick(config.config.headers, "authorization")
                }

                request(request_options, function(err, response){
                    if(!err && response.statusCode == 200){
                        clusters.push(response.body);
                        clusters = _.flatten(clusters);
                    }

                    clusters = _.indexBy(clusters, "id");

                    if(_.has(clusters, options["cluster-id"]) && clusters[options["cluster-id"]].provider == "vag"){
                        providers.vagrant.validate(function(err){
                            if(err)
                                throw err;

                            providers.vagrant.destroy(function(err){
                                if(err)
                                    throw err;

                                console.log(["Successfully destroyed cluster:", options["cluster-id"]].join(" "));
                            });
                        });
                    }
                    else{
                        process.stderr.write("Unable to destroy cluster!");
                        process.exit(1);
                    }
                });
            });
        }
    },

    "use-cluster": {
        options: {
            "cluster-id": {
                position: 1,
                help: "ContainerShip cluster ID",
                metavar: "CLUSTER ID",
                required: true
            }
        },
        callback: function(options){
            config.load();
            config.config["api-url"] = "https://api.containership.io";
            config.config.headers["x-containership-cloud-cluster"] = options["cluster-id"];
            config.set(config.config);
            console.log(["Successfully updated config to use cluster", options["cluster-id"]].join(" "));
        }
    },

    "list-clusters": {
        options: {},
        callback: function(options){
            config.load();

            providers.vagrant.get_clusters(function(err, clusters){
                var request_options = {
                    url: [
                        "https://api.containership.io",
                        "v2",
                        "organizations",
                        config.config.headers["x-containership-cloud-organization"],
                        "clusters"
                    ].join("/"),
                    method: "GET",
                    json: true,
                    headers: _.pick(config.config.headers, "authorization")
                }

                request(request_options, function(err, response){
                    if(!err && response.statusCode == 200){
                        clusters.push(response.body);
                        clusters = _.flatten(clusters);
                    }

                    var providers = {
                        aws: "Amazon Web Services",
                        do: "Digital Ocean",
                        na: "Not Available",
                        vag: "Vagrant"
                    }

                    console.log(sprintf("%-40s %-40s %-25s %-15s %-10s %-10s",
                        "ID",
                        "NAME",
                        "PROVIDER",
                        "APPLICATIONS",
                        "LEADERS",
                        "FOLLOWERS"
                    ));

                    _.each(clusters, function(cluster){
                        var hosts = _.groupBy(_.values(cluster.hosts), function(host){
                            return host.mode;
                        });

                        console.log(sprintf("%-40s %-40s %-25s %-15s %-10s %-10s",
                            cluster.id,
                            cluster.name || "",
                            providers[cluster.provider] || providers.na,
                            _.keys(cluster.applications).length,
                            hosts.leader && hosts.leader.length || "0",
                            hosts.follower && hosts.follower.length || "0"
                        ));
                    });
                });
            });
        }
    },

    build: {
        options: {},
        callback: function(options){
            var image = _.last(process.cwd().split("/"));

            var self = this;

            async.waterfall([
                function(fn){
                    fs.readFile([process.cwd(), ".gitignore"].join("/"), function(err, gitignore){
                        if(err)
                            return fn(undefined, new Buffer("# no gitignore present"));
                        else
                            return fn(undefined, gitignore);
                    });
                },
                function(gitignore, fn){
                    var ignored = [];
                    var lines = gitignore.toString().split("\n");
                    _.each(lines, function(line){
                        if(line.indexOf("#") != 0 && line.length > 0)
                            ignored.push(line);
                    });

                    return fn(undefined, ignored);
                },
                function(ignored, fn){
                    var start_index = process.cwd().length + 1;
                    var packager = tar.pack(process.cwd(), {
                        ignore: function(file){
                            var ignore = false;
                            file = file.substring(start_index, file.length);

                            _.each(ignored, function(pattern){
                                var match = glob.sync(pattern);
                                if(!_.isEmpty(match) && match[0] == file)
                                    ignore = true;
                            });

                            return ignore;
                        }
                    });

                    return fn(undefined, packager);
                },
                function(packager, fn){
                    config.load();

                    var options = {
                        url: ["https://build.containership.io", "v1", "organizations", config.config.headers["x-containership-cloud-organization"], image, "builds"].join("/"),
                        method: "POST",
                        headers: {
                            authorization: config.config.headers.authorization
                        }
                    }

                    packager.pipe(request(options)
                        .on("response", function(response){
                            var body;

                            response.on("data", function(data){
                                try{
                                    body = JSON.parse(data);
                                }
                                catch(e){
                                    body = e.message;
                                }
                            });

                            response.on("end", function(){
                                if(response.statusCode == 201)
                                    return fn(null, body);
                                else if(response.statusCode == 401)
                                    return fn(new Error("Authentication error! Your token may have expired. Please login again using the `cs cloud login` command"));
                                else
                                    return fn(new Error(["Build returned status code: ", response.statusCode, ". ", body].join("")));
                            });
                        })
                        .on("error", function(err){
                            return fn(err);
                        })
                    );
                }
            ], function(err, build_id){
                if(err){
                    process.stderr.write(err.message);
                    process.exit(1);
                }
                else{
                    console.log(["Starting build with ID:", build_id].join(" "));
                    var options = {
                        url: ["https://build.containership.io", "v1", "organizations", config.config.headers["x-containership-cloud-organization"], "builds", build_id, "logs"].join("/"),
                        method: "GET",
                        headers: {
                            authorization: config.config.headers.authorization
                        },
                        timeout: 300000
                    }

                    request(options).on("response", function(response){
                        response.on("data", function(data){
                            process.stdout.write(data.toString());
                        });
                    }).on("error", function(err){
                        console.log(err);
                    });
                }
            });
        }
    }

}

var config = {
    load: function(){
        try{
            this.config = JSON.parse(fs.readFileSync([process.env["HOME"], ".containership", "cli.json"].join("/")));
        }
        catch(e){
            process.stdout.write("Could not load Containership config file. Does it exist?");
            process.exit(1);
        }
    },

    set: function(new_config){
        var self = this;
        try{
            var config = JSON.parse(fs.readFileSync([process.env["HOME"], ".containership", "cli.json"].join("/")));
        }
        catch(e){
            var config = {};
        }

        try{
            fs.writeFileSync([process.env["HOME"], ".containership", "cli.json"].join("/"), JSON.stringify(new_config));
            this.config = config;
        }
        catch(e){
            process.stdout.write("Could not write Containership config file");
            process.exit(1);
        }
    }
}
