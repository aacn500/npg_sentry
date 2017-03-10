#!/usr/bin/env perl
use strict;
use warnings;
use FindBin qw($Bin);
use lib ( -d "$Bin/../lib/perl5" ? "$Bin/../lib/perl5" : "$Bin/../lib" );

use autodie;
use DateTime;
use Getopt::Long;
use List::MoreUtils qw(uniq);
use Log::Log4perl;
use Log::Log4perl::Level;
use MongoDB;
use JSON;
use WTSI::DNAP::Utilities::LDAP;

use npg_warehouse::Schema;

our $VERSION = '0';

my $embedded_conf = << 'LOGCONF';
   log4perl.logger.npg.acls = ERROR, A1

   log4perl.appender.A1           = Log::Log4perl::Appender::Screen
   log4perl.appender.A1.utf8      = 1
   log4perl.appender.A1.layout    = Log::Log4perl::Layout::PatternLayout
   log4perl.appender.A1.layout.ConversionPattern = %d %p %m %n
LOGCONF

my $what_on_earth =<<'WOE';

Script to update WTSI iRODS systems with groups corresponding to
Sequencescape studies.

Appropriate iRODS environment variables (e.g. irodsEnvFile) and files
should be set and configured to allow access and update of the desired
iRODS system.

The Sequencescape warehouse database is used to find the set of
studies. iRODS groups are created for each study with names of the
format ss_<study_id> when they do not already exist.

The iRODS zone is taken to have a pre-existing "public" group which is
used to identify all available users.

If a Sequencescape study has an entry for the "data_access_group" then
the intersection of the members of the corresponding WTSI unix group
and iRODS public group is used as the membership of the corresponding
iRODS group.

If no data_access_group is set on the study, then if the study is
associated with sequencing the members of the iRODS group will be set
to the public group, else if the study is not associated with
sequencing the iRODS group will be left empty (except for the iRODS
groupadmin user).

Script runs to perform such updates when no arguments are given.

Options:

  --db-name     Name and collection to compare old data. No effect unless
                --db-url is set. [sentry.users]
  --db-url      URL of mongo database to compare lists of users. Users that
                no longer appear will be marked as such. No effect unless
                --user-first is set.
  --debug       Enable debug level logging. Optional, defaults to false.
  --dry-run     Report proposed changes, do not perform them. Optional.
  --dry_run
  --eml         Email address to append to usernames
  --help        Display help.
  --logconf     A log4perl configuration file. Optional.
  --study       Restrict updates to a study. May be used multiple times
                to select more than one study. Optional.
                Mutually exclusive with --user-first.
  --user-first  Output users mapped to groups.
                Mutually exclusive with --study.
  --verbose     Print messages while processing. Optional.

WOE

my $dbname = 'sentry.users';
my $dburl;
my $debug;
my $dry_run;
my $eml = '';
my $log4perl_config;
my $userfirst;
my $verbose;
my @studies;

GetOptions('db-name=s'               => \$dbname,
           'db-url=s'                => \$dburl,
           'debug'                   => \$debug,
           'dry-run|dry_run'         => \$dry_run,
           'eml=s'                   => \$eml,
           'help'                    => sub {
             print $what_on_earth;
             exit 0;
           },
           'logconf=s'               => \$log4perl_config,
           'study=s'                 => \@studies,
           'user-first'              => \$userfirst,
           'verbose'                 => \$verbose) or die "\n$what_on_earth\n";

if ($log4perl_config) {
  Log::Log4perl::init($log4perl_config);
}
else {
  Log::Log4perl::init(\$embedded_conf);
}

my $log = Log::Log4perl->get_logger('npg.acls');
if ($verbose) {
  $log->level($INFO);
}
if ($debug) {
  $log->level($DEBUG);
}

if (@studies && $userfirst) {
  $log->logcroak("Options --study and --user-first are mutually exclusive!");
}

my @old_users;
if ($dburl && $userfirst) {
  my $client = MongoDB->connect($dburl);
  my $users_coll = $client->ns($dbname);
  my $cursor = $users_coll->find({"groups"   => {'$all' => \@studies}},
                                 {projection => {user => 1}});
  while (my $doc = $cursor->next) {
    push @old_users, $doc->{'user'};
  }
  $client->disconnect;
}

my $ldap = WTSI::DNAP::Utilities::LDAP->new;
my $group2users = $ldap->map_groups_to_users();

my @public;

foreach my $group ( keys %{ $group2users } ) {
  push @public, @{ $group2users->{$group} };
}

@public = uniq @public;

my @dnap_members;
for (split /^/, qx/igroupadmin lg dnap_ro/) {
  chomp;
  next if (not $_ =~ /#/);
  $_ =~ s/#.*$//;
  push @dnap_members, $_;
}

$log->info("The public group has ", scalar @public, ' members');
$log->debug("public group membership: ", join q(, ), @public);

my %public_hash = map { $_ => 1 } @public;
sub _uid_to_irods_uid {
  my($u)=@_;
  if ($public_hash{$u}) {
    return ($u);
  } else {
    return ();
  }
}

my $schema = npg_warehouse::Schema->connect;
my $rs;
if (@studies) {
  $rs = $schema->resultset(q(CurrentStudy))->search({internal_id => \@studies});
}
else {
  $rs = $schema->resultset(q(CurrentStudy));
}

my %user2groups;

my $group_count = 0;
while (my $study = $rs->next){
  my $study_id = $study->internal_id;
  my $dag_str  = $study->data_access_group || q();
  my $is_seq   = $study->npg_information->count ||
                 $study->npg_plex_information->count;

  $log->debug("Working on study $study_id, SScape data access: '$dag_str'");

  my @members;
  my @dags = $dag_str =~ m/\S+/smxg;
  if (@dags) {
    # if strings from data access group don't match any group name try
    # treating as usernames
    @members = map { _uid_to_irods_uid($_)   }
               map { @{ $group2users->{$_} || [$_] } } @dags;
  }
  elsif ($is_seq) {
    @members = @public;
  }
  else {
    # remains empty
  }
  push @members, @dnap_members;

  $log->info("Study $study_id has ", scalar @members, ' members');
  $log->debug('Members: ', join q(, ), @members);

  if (! $userfirst ) {
    @members = map {$_ . $eml} @members;
    print to_json({access_control_group_id=>$study_id, members=>\@members})."\n";
  }
  else {
    foreach my $uname ( uniq @members ) {
      push @{$user2groups{$uname}}, $study_id;
    }
  }

  $group_count++;
}


if ( $userfirst ) {
  my @merged = uniq (keys %user2groups, @old_users);

  my $today = DateTime->now(time_zone => 'UTC');

  foreach my $uname ( @merged ) {
    if ( $dburl ) {
      if ( exists( $user2groups{$uname} ) ) {
        print to_json(
          {user=>$uname.$eml, groups=>$user2groups{$uname}, current=>JSON::true, last_modified=>''.$today}
        )."\n";
      }
      else {
        # User was in db previously, but not in new list of users.
        # Remove user from all groups, set current to false.
        print to_json(
          {user=>$uname.$eml, groups=>[], current=>JSON::false, last_modified=>''.$today}
        )."\n";
      }
    }
    else {
      print to_json(
        {user=>$uname.$eml, groups=>$user2groups{$uname}, last_modified=>$today}
      )."\n";
    }
  }
}

$log->info("Considered $group_count Sequencescape studies");
