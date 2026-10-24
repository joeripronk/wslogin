'use strict';

// Reusable login form shared by the wslogin page and the sudovideo
// playback login page. The markup is the wslogin login form; hosts
// mount it into their own container and provide a submit handler:
//
//   LoginForm.mount(container, function(username, password, remember) {
//     ...authenticate...
//   });
//   LoginForm.status('please login');   // set the status line
//   LoginForm.fail('Authentication failed'); // clear password, show error
//   LoginForm.focus();                  // focus the username field

var LoginForm = (function() {
  var MARKUP = '<form method=post onsubmit="return false;">'
    + '<div class="formcontainer">'
    + '<label for="username"><b>Username</b></label>'
    + '<input type="text" placeholder="Enter Username" id="username" name="uname" required autocomplete="username">'
    + '<label for="password"><b>Password</b></label>'
    + '<input type="password" placeholder="Enter Password" id="password" name="psw" required autocomplete="current-password">'
    + '<button type="submit">Login</button>'
    + '<label>'
    + '<input id="rememberme" type="checkbox" checked="checked" name="remember"> Remember me'
    + '</label>'
    + '</div>'
    + '<div class="container">'
    + '<span id="formstatus" class="psw"></span>'
    + '</div>'
    + '</form>';

  var container = null;

  function field(id) {
    return container ? container.querySelector('#' + id) : null;
  }

  function mount(el, onSubmit) {
    container = el;
    container.innerHTML = MARKUP;
    var form = container.querySelector('form');
    form.onsubmit = function(event) {
      event.preventDefault();
      status('Authenticating');
      onSubmit(field('username').value, field('password').value,
        field('rememberme').checked);
      return false;
    };
  }

  function status(html) {
    var formstatus = field('formstatus');
    if (formstatus) formstatus.innerHTML = html;
  }

  function fail(message) {
    status('<span class="login-error">'
      + (message || 'Authentication failed') + '</span>');
    var password = field('password');
    if (password) {
      password.value = '';
      password.focus();
    }
  }

  function focus() {
    var username = field('username');
    if (username) username.focus();
  }

  function visible() {
    return !!container && container.style.display != 'none';
  }

  return { mount: mount, status: status, fail: fail, focus: focus,
    visible: visible };
})();
