var gulp = require('gulp');
var ts = require('gulp-typescript');
var sourcemaps = require('gulp-sourcemaps');
var config = require('../../gulpconfig.js');
var path = require("path");

var tsProject = ts.createProject('tsconfig-backend.json');
var tsProjectFrontend = ts.createProject('tsconfig-frontend.json');

function countslash(st) {

    for (var i = count = 0; i < st.length; count += +("/" === st[i++]));

    return count;
}

function goUp(num) {

    var st = "";
    while (num--) {
        st += "../";
    }
    return st;
}

gulp.task('build-frontend', [], function () {
    console.log("Building AMD for frontend -----------------------\n\n\n\n\n");
    var dist = "./dist/client-browser"
    var tsResult = gulp.src(config.backend.sourceTsFiles)
        .pipe(sourcemaps.init())
        .pipe(ts(tsProjectFrontend));

    tsResult.dts.pipe(gulp.dest(dist));
    gulp.src("backend/ambient.d.ts").pipe(gulp.dest(dist));
    return tsResult.js
        .pipe(sourcemaps.write('.', {
            includeContent: false, sourceRoot: function (file) {
                return goUp(countslash(file.sourceMap.file)) + "../backend";
            }
        }))
        .pipe(gulp.dest(dist));

});

gulp.task('build-backend', ['build-frontend'], function () {
    console.log("Building commonjs for backend -----------------------\n\n\n\n\n");

    var tsResult = gulp.src(config.backend.sourceTsFiles)
        .pipe(sourcemaps.init())
        .pipe(ts(tsProject));

    tsResult.dts.pipe(gulp.dest("./dist"));

    gulp.src("package.json").pipe(gulp.dest("./dist"));
    gulp.src("README.md").pipe(gulp.dest("./dist"));
    return tsResult.js
        .pipe(sourcemaps.write('.', {
            includeContent: false, sourceRoot: function (file) {
                return goUp(countslash(file.sourceMap.file)) + "../backend";
            }
        }))
        .pipe(gulp.dest("./dist"));
});

