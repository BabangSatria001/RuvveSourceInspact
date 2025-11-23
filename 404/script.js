// Initialize page without parallax effect
document.addEventListener('DOMContentLoaded', function() {
    
    // I dare button functionality - go back to previous page
    const dareButton = document.getElementById('dareButton');
    dareButton.addEventListener('click', function() {
        // Go back to previous page in history
        if (window.history.length > 1) {
            window.history.back();
        } else {
            // If no history, go to homepage
            window.location.href = '/';
        }
    });
    
});