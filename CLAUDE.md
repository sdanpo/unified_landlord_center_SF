# Project Context

When working with this codebase, prioritize readability over cleverness. Ask clarifying questions before making architectural changes.

## About This Project

You are writing a toll which should lower the operational overhead of a team managing multiple properties in the US out-of-state.
Your goal is to minize the work of both the implementer giving you instructions and the users.

## codebase

- Code should be thoroughly checked. Tests should be administered for any new features.
- You are using ERPNEXT V15 on Frappe which has multiple modules. Try not to reinvent the wheel but rather use apps and modules for ERPNext to simplify your work.

## Standards

- Always opt for using a well working product with paid API rather than building everything from scratch.
- Logs should be written to help you debug the code and find issues in no time.
- Try and seprate the code into logical units so that it will be readable and maintainable.

## Testing
- Test every flow you can think of including corner cases
- Feel free to use dummy data (dummy properties, dummy maintenance calls , dummy vendors, maintenance visits , etc).
- Feel free to build mocks
- Feel free to use any tool you can think of - You are also installed on the browser as Chrome extensions, you can use playwright, or any other tool or measure in order for the code to be fully tested.
- All flows should be thoroughly tested
- Dummy data should be built so that it will allow for you to test any use case and corner case of the system including the telegram messages for each relevant case (e.g. late maintenance call, late payment, etc).


## Notes
